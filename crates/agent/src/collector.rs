//! 系统指标采集。基于 sysinfo，跨平台读取 CPU / 内存 / 磁盘 / 网卡 / 负载。

use myprobe_shared::protocol::{DiskSample, MetricsSample, SystemInfo};
use sysinfo::{Disks, Networks, System};

/// 伪文件系统 / 容器叠加层 / 网络挂载：都不应计入本机磁盘容量。
/// 少了这层过滤，宿主机上的 snap（squashfs）、tmpfs、容器 overlay 会把总量放大数倍。
const SKIP_FS: &[&str] = &[
    "autofs",
    "binfmt_misc",
    "bpf",
    "cgroup",
    "cgroup2",
    "cifs",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "drvfs",
    "efivarfs",
    "fuse.portal",
    "fuse.snapfuse",
    "fuse.sshfs",
    "fusectl",
    "hugetlbfs",
    "iso9660",
    "mqueue",
    "nfs",
    "nfs4",
    "nsfs",
    "overlay",
    "proc",
    "pstore",
    "ramfs",
    "rootfs",
    "securityfs",
    "smbfs",
    "squashfs",
    "sysfs",
    "tmpfs",
    "tracefs",
    "9p",
];

/// 该挂载点是否应计入磁盘统计。
fn countable(disk: &sysinfo::Disk) -> bool {
    if disk.total_space() == 0 {
        return false;
    }
    let fs = disk.file_system().to_string_lossy().to_ascii_lowercase();
    if SKIP_FS.iter().any(|s| fs == *s) {
        return false;
    }
    let mount = disk.mount_point().to_string_lossy();
    // 容器里 /etc/hosts 之类的 bind mount 会以宿主设备容量重复出现
    !mount.starts_with("/proc")
        && !mount.starts_with("/sys")
        && !mount.starts_with("/dev")
        && !mount.starts_with("/run")
        && !mount.starts_with("/snap")
        && !mount.starts_with("/etc/")
        && !mount.starts_with("/var/lib/docker")
        && !mount.starts_with("/var/lib/kubelet")
}

pub struct Collector {
    sys: System,
    nets: Networks,
    disks: Disks,
}

impl Collector {
    pub fn new() -> Self {
        Collector {
            sys: System::new_all(),
            nets: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
        }
    }

    /// 采集一整份指标。
    pub fn sample(&mut self) -> MetricsSample {
        // 刷新易变部分：CPU 使用率、内存、网卡速率
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(false);
        self.disks.refresh(false);

        let mut disk_samples: Vec<DiskSample> = Vec::new();
        // 同一设备的多个挂载点（bind mount、btrfs 子卷）只算一次
        let mut seen: Vec<String> = Vec::new();
        for d in self.disks.list().iter().filter(|d| countable(d)) {
            let dev = d.name().to_string_lossy().to_string();
            if seen.contains(&dev) {
                continue;
            }
            seen.push(dev);
            disk_samples.push(DiskSample {
                mount: d.mount_point().display().to_string(),
                total: d.total_space(),
                used: d.total_space().saturating_sub(d.available_space()),
            });
        }
        // 挂载点排序，保证顺序稳定
        disk_samples.sort_by(|a, b| a.mount.cmp(&b.mount));

        let mut net_in: u64 = 0;
        let mut net_out: u64 = 0;
        for nd in self.nets.list().values() {
            // received()/transmitted() 为自上次刷新以来的速率（bytes/s）
            net_in += nd.received();
            net_out += nd.transmitted();
        }

        let load = System::load_average();

        MetricsSample {
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            cpu_usage: self.sys.global_cpu_usage(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            swap_used: self.sys.used_swap(),
            swap_total: self.sys.total_swap(),
            disks: disk_samples,
            net_in_rate: net_in,
            net_out_rate: net_out,
            load_one: load.one,
            load_five: load.five,
            load_fifteen: load.fifteen,
            uptime_s: System::uptime(),
        }
    }
}

/// 静态系统信息（连接注册时上报一次）。
pub fn system_info() -> SystemInfo {
    let sys = System::new_all();
    let cpus = sys.cpus();
    SystemInfo {
        hostname: System::host_name().unwrap_or_else(|| "unknown".into()),
        os: format!(
            "{} {}",
            std::env::consts::OS,
            System::os_version().unwrap_or_default()
        ),
        arch: std::env::consts::ARCH.to_string(),
        kernel: System::kernel_version().unwrap_or_default(),
        cpu_model: cpus.first().map(|c| c.brand().to_string()).unwrap_or_default(),
        cpu_cores: cpus.len(),
        total_memory: sys.total_memory(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

impl Default for Collector {
    fn default() -> Self {
        Self::new()
    }
}
