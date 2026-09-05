//! SQLite 持久层。使用 rusqlite bundled，单文件、无外部依赖。

use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use myprobe_shared::protocol::{ProbeProtocol, ProbeResult};
use rusqlite::{Connection, OptionalExtension, params};

use crate::models::{AlertRules, MetricPoint, NotifierConfig, Probe, ProbePoint, RenewCycle, Server};

pub struct Db {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    secret       TEXT NOT NULL UNIQUE,
    country      TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    expire_date  TEXT,
    renew_price  REAL NOT NULL DEFAULT 0,
    renew_cycle  TEXT NOT NULL DEFAULT 'month',
    report_interval_s INTEGER NOT NULL DEFAULT 5,
    created_at   TEXT NOT NULL,
    last_seen    INTEGER NOT NULL DEFAULT 0
);

-- 探测目标独立于服务器：一个探测可以派给任意多个客户端执行。
CREATE TABLE IF NOT EXISTS probes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    target      TEXT NOT NULL,
    protocol    TEXT NOT NULL DEFAULT 'tcp',
    port        INTEGER,
    timeout_ms  INTEGER NOT NULL DEFAULT 5000,
    interval_s  INTEGER NOT NULL DEFAULT 60,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_assignments (
    probe_id    INTEGER NOT NULL REFERENCES probes(id) ON DELETE CASCADE,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    PRIMARY KEY(probe_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_server ON probe_assignments(server_id);

CREATE TABLE IF NOT EXISTS metric_samples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    cpu         REAL NOT NULL,
    mem_used    INTEGER NOT NULL,
    mem_total   INTEGER NOT NULL,
    disk_used   INTEGER NOT NULL DEFAULT 0,
    disk_total  INTEGER NOT NULL DEFAULT 0,
    net_in      INTEGER NOT NULL DEFAULT 0,
    net_out     INTEGER NOT NULL DEFAULT 0,
    load1       REAL NOT NULL DEFAULT 0,
    uptime      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metric_server_ts ON metric_samples(server_id, ts);

CREATE TABLE IF NOT EXISTS probe_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    probe_id    INTEGER NOT NULL,
    server_id   INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    latency_ms  REAL
);
CREATE INDEX IF NOT EXISTS idx_probe_server_ts ON probe_results(server_id, ts);
CREATE INDEX IF NOT EXISTS idx_probe_result_probe ON probe_results(probe_id, server_id, ts);
"#;

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ErrorCode::CannotOpen as i32),
                    Some(format!("无法创建数据目录: {e}")),
                )
            })?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", "5000")?;
        conn.execute_batch(SCHEMA)?;
        migrate_probes(&conn)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    // ---------- settings ----------

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 获取或生成长效密钥（如 JWT secret）。
    pub fn get_or_create_setting(&self, key: &str, create: impl FnOnce() -> String) -> String {
        if let Some(v) = self.get_setting(key) {
            return v;
        }
        let v = create();
        let _ = self.set_setting(key, &v);
        v
    }

    pub fn get_alert_rules(&self) -> AlertRules {
        self.get_setting("alert_rules")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn set_alert_rules(&self, rules: &AlertRules) -> rusqlite::Result<()> {
        self.set_setting("alert_rules", &serde_json::to_string(rules).unwrap())
    }

    pub fn get_notifiers(&self) -> Vec<NotifierConfig> {
        self.get_setting("notifiers")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn set_notifiers(&self, list: &[NotifierConfig]) -> rusqlite::Result<()> {
        self.set_setting("notifiers", &serde_json::to_string(list).unwrap())
    }

    // ---------- servers ----------

    pub fn list_servers(&self) -> Vec<Server> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id, name, secret, country, note, enabled, expire_date,
                        renew_price, renew_cycle, report_interval_s, created_at, last_seen
                 FROM servers ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], row_to_server)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_server(&self, id: i64) -> Option<Server> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id, name, secret, country, note, enabled, expire_date,
                    renew_price, renew_cycle, report_interval_s, created_at, last_seen
             FROM servers WHERE id = ?1",
            params![id],
            row_to_server,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_server_by_secret(&self, secret: &str) -> Option<Server> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id, name, secret, country, note, enabled, expire_date,
                    renew_price, renew_cycle, report_interval_s, created_at, last_seen
             FROM servers WHERE secret = ?1",
            params![secret],
            row_to_server,
        )
        .optional()
        .ok()
        .flatten()
    }

    // 建表字段逐个传入，比额外包一层 DTO 更直观
    #[allow(clippy::too_many_arguments)]
    pub fn create_server(
        &self,
        name: &str,
        secret: &str,
        country: &str,
        note: &str,
        expire_date: Option<&str>,
        renew_price: f64,
        renew_cycle: RenewCycle,
        report_interval: i64,
    ) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO servers(name, secret, country, note, expire_date, renew_price, renew_cycle, report_interval_s, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                name,
                secret,
                country,
                note,
                expire_date,
                renew_price,
                renew_cycle.as_str(),
                report_interval,
                Self::now_iso()
            ],
        )?;
        Ok(c.last_insert_rowid())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_server(
        &self,
        id: i64,
        name: &str,
        country: &str,
        note: &str,
        enabled: bool,
        expire_date: Option<&str>,
        renew_price: f64,
        renew_cycle: RenewCycle,
        report_interval: i64,
    ) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE servers SET name=?1, country=?2, note=?3, enabled=?4,
                    expire_date=?5, renew_price=?6, renew_cycle=?7, report_interval_s=?8
             WHERE id=?9",
            params![
                name,
                country,
                note,
                enabled as i64,
                expire_date,
                renew_price,
                renew_cycle.as_str(),
                report_interval,
                id
            ],
        )?;
        Ok(())
    }

    pub fn delete_server(&self, id: i64) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM servers WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn touch_last_seen(&self, id: i64, ts: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("UPDATE servers SET last_seen=?1 WHERE id=?2", params![ts, id]);
    }

    pub fn rotate_secret(&self, id: i64, secret: &str) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("UPDATE servers SET secret=?1 WHERE id=?2", params![secret, id])?;
        Ok(())
    }

    // ---------- probes ----------

    /// 全部探测目标（后台探测列表）。
    pub fn list_probes(&self) -> Vec<Probe> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id, name, target, protocol, port, timeout_ms, interval_s, enabled
                 FROM probes ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], row_to_probe)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// 指派给某客户端执行的探测目标。
    pub fn probes_for_server(&self, server_id: i64) -> Vec<Probe> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT p.id, p.name, p.target, p.protocol, p.port, p.timeout_ms, p.interval_s, p.enabled
                 FROM probes p JOIN probe_assignments a ON a.probe_id = p.id
                 WHERE a.server_id = ?1 ORDER BY p.id",
            )
            .unwrap();
        stmt.query_map(params![server_id], row_to_probe)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_probe(&self, id: i64) -> Option<Probe> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id, name, target, protocol, port, timeout_ms, interval_s, enabled
             FROM probes WHERE id=?1",
            params![id],
            row_to_probe,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// 全部指派关系 (probe_id, server_id)，一次查询供两个方向的视图使用。
    pub fn probe_assignments(&self) -> Vec<(i64, i64)> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT probe_id, server_id FROM probe_assignments ORDER BY probe_id, server_id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// 某探测目标当前指派的客户端。
    pub fn servers_for_probe(&self, probe_id: i64) -> Vec<i64> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT server_id FROM probe_assignments WHERE probe_id=?1 ORDER BY server_id")
            .unwrap();
        stmt.query_map(params![probe_id], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// 覆盖某探测目标的客户端列表，返回受影响（新增或移除）的客户端。
    pub fn set_probe_servers(&self, probe_id: i64, server_ids: &[i64]) -> rusqlite::Result<Vec<i64>> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        let before: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT server_id FROM probe_assignments WHERE probe_id=?1")?;
            let v = stmt
                .query_map(params![probe_id], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            v
        };
        tx.execute(
            "DELETE FROM probe_assignments WHERE probe_id=?1",
            params![probe_id],
        )?;
        for sid in server_ids {
            tx.execute(
                "INSERT OR IGNORE INTO probe_assignments(probe_id, server_id) VALUES(?1, ?2)",
                params![probe_id, sid],
            )?;
        }
        tx.commit()?;
        Ok(symmetric_diff(&before, server_ids))
    }

    /// 覆盖某客户端执行的探测目标列表，返回是否有变化。
    pub fn set_server_probes(&self, server_id: i64, probe_ids: &[i64]) -> rusqlite::Result<bool> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        let before: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT probe_id FROM probe_assignments WHERE server_id=?1")?;
            let v = stmt
                .query_map(params![server_id], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            v
        };
        tx.execute(
            "DELETE FROM probe_assignments WHERE server_id=?1",
            params![server_id],
        )?;
        for pid in probe_ids {
            tx.execute(
                "INSERT OR IGNORE INTO probe_assignments(probe_id, server_id) VALUES(?1, ?2)",
                params![pid, server_id],
            )?;
        }
        tx.commit()?;
        Ok(!symmetric_diff(&before, probe_ids).is_empty())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_probe(
        &self,
        name: &str,
        target: &str,
        protocol: ProbeProtocol,
        port: Option<u16>,
        timeout_ms: u64,
        interval_s: u64,
        enabled: bool,
    ) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO probes(name, target, protocol, port, timeout_ms, interval_s, enabled, created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                name,
                target,
                protocol.as_str(),
                port,
                timeout_ms as i64,
                interval_s as i64,
                enabled as i64,
                Self::now_iso()
            ],
        )?;
        Ok(c.last_insert_rowid())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_probe(
        &self,
        id: i64,
        name: &str,
        target: &str,
        protocol: ProbeProtocol,
        port: Option<u16>,
        timeout_ms: u64,
        interval_s: u64,
        enabled: bool,
    ) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE probes SET name=?1, target=?2, protocol=?3, port=?4,
                    timeout_ms=?5, interval_s=?6, enabled=?7 WHERE id=?8",
            params![
                name,
                target,
                protocol.as_str(),
                port,
                timeout_ms as i64,
                interval_s as i64,
                enabled as i64,
                id
            ],
        )?;
        Ok(())
    }

    pub fn delete_probe(&self, id: i64) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM probes WHERE id=?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn count_metrics(&self, server_id: i64) -> usize {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM metric_samples WHERE server_id=?1",
            params![server_id],
            |r| r.get::<_, i64>(0).map(|v| v as usize),
        )
        .unwrap_or(0)
    }

    /// 服务器最近一条指标。
    #[allow(dead_code)]
    pub fn latest_metric(&self, server_id: i64) -> Option<MetricPoint> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT ts, cpu, mem_used, mem_total, disk_used, disk_total, net_in, net_out, load1, uptime
             FROM metric_samples WHERE server_id=?1 ORDER BY id DESC LIMIT 1",
            params![server_id],
            row_to_metric,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// 某客户端对某探测目标的最近一条结果。
    pub fn probe_latest(&self, probe_id: i64, server_id: i64) -> Option<ProbePoint> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT ts, ok, latency_ms FROM probe_results
             WHERE probe_id=?1 AND server_id=?2 ORDER BY id DESC LIMIT 1",
            params![probe_id, server_id],
            row_to_probe_point,
        )
        .optional()
        .ok()
        .flatten()
    }

    // ---------- samples ----------

    pub fn insert_metric(
        &self,
        server_id: i64,
        m: &myprobe_shared::protocol::MetricsSample,
    ) -> rusqlite::Result<()> {
        let disk_used: u64 = m.disks.iter().map(|d| d.used).sum();
        let disk_total: u64 = m.disks.iter().map(|d| d.total).sum();
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO metric_samples(server_id, ts, cpu, mem_used, mem_total,
                    disk_used, disk_total, net_in, net_out, load1, uptime)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                server_id,
                m.ts,
                m.cpu_usage,
                m.mem_used as i64,
                m.mem_total as i64,
                disk_used as i64,
                disk_total as i64,
                m.net_in_rate as i64,
                m.net_out_rate as i64,
                m.load_one,
                m.uptime_s as i64
            ],
        )?;
        Ok(())
    }

    /// 只保留最近的 N 条指标，避免增长无界。
    /// 用「第 N+1 新的 ts」当水位线，走 (server_id, ts) 索引，不做全表扫描。
    pub fn prune_metrics(&self, server_id: i64, keep: usize) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "DELETE FROM metric_samples WHERE server_id=?1 AND ts < (
                SELECT ts FROM metric_samples WHERE server_id=?1 ORDER BY ts DESC LIMIT 1 OFFSET ?2
            )",
            params![server_id, keep as i64],
        );
    }

    /// 按时间范围查询指标。样本数超过 points 时直接在 SQL 里按时间桶聚合，
    /// 均值之外一并带上桶内峰值，长范围曲线不会因为抽样丢掉尖峰。
    pub fn metric_history(&self, server_id: i64, since_ms: i64, points: usize) -> Vec<MetricPoint> {
        let points = points.max(1);
        let c = self.conn.lock().unwrap();
        let Some((count, min_ts, max_ts)) = range_stats(
            &c,
            "SELECT COUNT(*), MIN(ts), MAX(ts) FROM metric_samples WHERE server_id=?1 AND ts>=?2",
            params![server_id, since_ms],
        ) else {
            return Vec::new();
        };
        if count <= points {
            let mut stmt = c
                .prepare(
                    "SELECT ts, cpu, mem_used, mem_total, disk_used, disk_total, net_in, net_out, load1, uptime
                     FROM metric_samples WHERE server_id=?1 AND ts>=?2 ORDER BY ts ASC",
                )
                .unwrap();
            return stmt
                .query_map(params![server_id, since_ms], row_to_metric)
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
        }
        let bucket = bucket_ms(min_ts, max_ts, points);
        let mut stmt = c
            .prepare(
                "SELECT CAST(AVG(ts) AS INTEGER), AVG(cpu), MAX(cpu),
                        CAST(AVG(mem_used) AS INTEGER), CAST(AVG(mem_total) AS INTEGER),
                        CAST(AVG(disk_used) AS INTEGER), CAST(AVG(disk_total) AS INTEGER),
                        CAST(AVG(net_in) AS INTEGER), MAX(net_in),
                        CAST(AVG(net_out) AS INTEGER), MAX(net_out),
                        AVG(load1), MAX(load1), MAX(uptime)
                 FROM metric_samples WHERE server_id=?1 AND ts>=?2
                 GROUP BY (ts - ?3) / ?4 ORDER BY 1 ASC",
            )
            .unwrap();
        stmt.query_map(params![server_id, since_ms, min_ts, bucket], row_to_metric_bucket)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn insert_probe_result(&self, server_id: i64, r: &ProbeResult) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO probe_results(probe_id, server_id, ts, ok, latency_ms)
             VALUES(?1,?2,?3,?4,?5)",
            params![r.probe_id, server_id, r.ts, r.ok as i64, r.latency_ms],
        )?;
        Ok(())
    }

    /// 同 prune_metrics：按 (server_id, ts) 索引裁掉水位线以前的探测结果。
    pub fn prune_probe_results(&self, server_id: i64, keep: usize) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "DELETE FROM probe_results WHERE server_id=?1 AND ts < (
                SELECT ts FROM probe_results WHERE server_id=?1 ORDER BY ts DESC LIMIT 1 OFFSET ?2
            )",
            params![server_id, keep as i64],
        );
    }

    /// 探测历史。长范围同样在 SQL 里聚合：延迟取均值与峰值，丢包取桶内失败比例。
    pub fn probe_history(
        &self,
        probe_id: i64,
        server_id: i64,
        since_ms: i64,
        points: usize,
    ) -> Vec<ProbePoint> {
        let points = points.max(1);
        let c = self.conn.lock().unwrap();
        let Some((count, min_ts, max_ts)) = range_stats(
            &c,
            "SELECT COUNT(*), MIN(ts), MAX(ts) FROM probe_results
             WHERE probe_id=?1 AND server_id=?2 AND ts>=?3",
            params![probe_id, server_id, since_ms],
        ) else {
            return Vec::new();
        };
        if count <= points {
            let mut stmt = c
                .prepare(
                    "SELECT ts, ok, latency_ms FROM probe_results
                     WHERE probe_id=?1 AND server_id=?2 AND ts>=?3 ORDER BY ts ASC",
                )
                .unwrap();
            return stmt
                .query_map(params![probe_id, server_id, since_ms], row_to_probe_point)
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
        }
        let bucket = bucket_ms(min_ts, max_ts, points);
        // 失败的样本 latency_ms 为 NULL，AVG / MAX 会自动跳过，只统计成功那部分。
        let mut stmt = c
            .prepare(
                "SELECT CAST(AVG(ts) AS INTEGER), SUM(ok), COUNT(*), AVG(latency_ms), MAX(latency_ms)
                 FROM probe_results WHERE probe_id=?1 AND server_id=?2 AND ts>=?3
                 GROUP BY (ts - ?4) / ?5 ORDER BY 1 ASC",
            )
            .unwrap();
        stmt.query_map(
            params![probe_id, server_id, since_ms, min_ts, bucket],
            row_to_probe_bucket,
        )
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// 统计某客户端对某探测目标最近 window 秒的可用率与平均延迟。
    pub fn probe_summary(&self, probe_id: i64, server_id: i64, window_s: i64) -> Option<(f64, f64)> {
        let since = Utc::now().timestamp_millis() - window_s * 1000;
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT CAST(SUM(ok) AS REAL) / COUNT(*), AVG(latency_ms)
             FROM probe_results WHERE probe_id=?1 AND server_id=?2 AND ts>=?3",
            params![probe_id, server_id, since],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, Option<f64>>(1)?.unwrap_or(0.0))),
        )
        .optional()
        .ok()
        .flatten()
    }

    // ---------- maintenance ----------

    pub fn purge_old_samples(&self, retention_days: i64) {
        let cutoff = Utc::now().timestamp_millis() - retention_days * 86_400_000;
        let c = self.conn.lock().unwrap();
        let _ = c.execute("DELETE FROM metric_samples WHERE ts<?1", params![cutoff]);
        let _ = c.execute("DELETE FROM probe_results WHERE ts<?1", params![cutoff]);
    }
}

fn row_to_server(r: &rusqlite::Row) -> rusqlite::Result<Server> {
    let last_seen: i64 = r.get(11)?;
    let created_raw: String = r.get(10)?;
    let created_at = chrono::DateTime::parse_from_rfc3339(&created_raw)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    Ok(Server {
        id: r.get(0)?,
        name: r.get(1)?,
        secret: r.get(2)?,
        country: r.get(3)?,
        note: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        expire_date: r.get(6)?,
        renew_price: r.get(7)?,
        renew_cycle: RenewCycle::parse(&r.get::<_, String>(8)?),
        report_interval_s: r.get::<_, i64>(9)? as u64,
        created_at,
        last_seen,
        online: false,
    })
}

fn row_to_probe(r: &rusqlite::Row) -> rusqlite::Result<Probe> {
    Ok(Probe {
        id: r.get(0)?,
        name: r.get(1)?,
        target: r.get(2)?,
        protocol: ProbeProtocol::parse(&r.get::<_, String>(3)?).unwrap_or(ProbeProtocol::Tcp),
        port: r.get(4)?,
        timeout_ms: r.get::<_, i64>(5)? as u64,
        interval_s: r.get::<_, i64>(6)? as u64,
        enabled: r.get::<_, i64>(7)? != 0,
    })
}

/// 旧版本的探测目标直接挂在服务器下（probes.server_id）。这里把它拆成
/// 独立的 probes + probe_assignments，老数据按原归属生成一条指派记录。
fn migrate_probes(conn: &Connection) -> rusqlite::Result<()> {
    let legacy = {
        let mut stmt = conn.prepare("PRAGMA table_info(probes)")?;
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        cols.iter().any(|c| c == "server_id")
    };
    if !legacy {
        return Ok(());
    }
    tracing::info!("迁移数据库：探测目标与服务器解耦");
    conn.execute_batch(
        r#"
PRAGMA foreign_keys=OFF;
BEGIN;
INSERT OR IGNORE INTO probe_assignments(probe_id, server_id)
    SELECT id, server_id FROM probes;
CREATE TABLE probes_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    target      TEXT NOT NULL,
    protocol    TEXT NOT NULL DEFAULT 'tcp',
    port        INTEGER,
    timeout_ms  INTEGER NOT NULL DEFAULT 5000,
    interval_s  INTEGER NOT NULL DEFAULT 60,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);
INSERT INTO probes_new(id, name, target, protocol, port, timeout_ms, interval_s, enabled, created_at)
    SELECT id, name, target, protocol, port, timeout_ms, interval_s, enabled, created_at FROM probes;
DROP TABLE probes;
ALTER TABLE probes_new RENAME TO probes;
COMMIT;
"#,
    )
}

/// 两个 id 集合的对称差，用来判断指派关系是否发生变化。
fn symmetric_diff(a: &[i64], b: &[i64]) -> Vec<i64> {
    let mut out: Vec<i64> = a
        .iter()
        .filter(|x| !b.contains(x))
        .chain(b.iter().filter(|x| !a.contains(x)))
        .copied()
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn row_to_metric(r: &rusqlite::Row) -> rusqlite::Result<MetricPoint> {
    Ok(MetricPoint {
        ts: r.get(0)?,
        cpu: r.get(1)?,
        mem_used: r.get::<_, i64>(2)? as u64,
        mem_total: r.get::<_, i64>(3)? as u64,
        disk_used: r.get::<_, i64>(4)? as u64,
        disk_total: r.get::<_, i64>(5)? as u64,
        net_in: r.get::<_, i64>(6)? as u64,
        net_out: r.get::<_, i64>(7)? as u64,
        load1: r.get(8)?,
        uptime: r.get::<_, i64>(9)? as u64,
        cpu_max: None,
        net_in_max: None,
        net_out_max: None,
        load1_max: None,
    })
}

/// 聚合后的指标桶，列顺序与 metric_history 里的 GROUP BY 查询一致。
fn row_to_metric_bucket(r: &rusqlite::Row) -> rusqlite::Result<MetricPoint> {
    Ok(MetricPoint {
        ts: r.get(0)?,
        cpu: r.get::<_, f64>(1)? as f32,
        mem_used: r.get::<_, i64>(3)? as u64,
        mem_total: r.get::<_, i64>(4)? as u64,
        disk_used: r.get::<_, i64>(5)? as u64,
        disk_total: r.get::<_, i64>(6)? as u64,
        net_in: r.get::<_, i64>(7)? as u64,
        net_out: r.get::<_, i64>(9)? as u64,
        load1: r.get(11)?,
        uptime: r.get::<_, i64>(13)? as u64,
        cpu_max: Some(r.get::<_, f64>(2)? as f32),
        net_in_max: Some(r.get::<_, i64>(8)? as u64),
        net_out_max: Some(r.get::<_, i64>(10)? as u64),
        load1_max: Some(r.get(12)?),
    })
}

fn row_to_probe_point(r: &rusqlite::Row) -> rusqlite::Result<ProbePoint> {
    Ok(ProbePoint {
        ts: r.get(0)?,
        ok: r.get::<_, i64>(1)? != 0,
        latency_ms: r.get(2)?,
        latency_max: None,
        loss: None,
    })
}

/// 聚合后的探测桶：ok 表示桶内至少成功一次，loss 是失败占比。
fn row_to_probe_bucket(r: &rusqlite::Row) -> rusqlite::Result<ProbePoint> {
    let ok_count: i64 = r.get(1)?;
    let total: i64 = r.get(2)?;
    Ok(ProbePoint {
        ts: r.get(0)?,
        ok: ok_count > 0,
        latency_ms: r.get(3)?,
        latency_max: r.get(4)?,
        loss: Some(1.0 - ok_count as f64 / total.max(1) as f64),
    })
}

/// 范围内的样本数与首末时间；范围为空时返回 None。
fn range_stats(c: &Connection, sql: &str, p: impl rusqlite::Params) -> Option<(usize, i64, i64)> {
    c.query_row(sql, p, |r| {
        Ok((
            r.get::<_, i64>(0)? as usize,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
        ))
    })
    .ok()
    .and_then(|(n, lo, hi)| Some((n, lo?, hi?)))
}

/// 时间桶宽度：把 [min_ts, max_ts] 均分成不超过 points 个桶。
fn bucket_ms(min_ts: i64, max_ts: i64, points: usize) -> i64 {
    let span = (max_ts - min_ts).max(1);
    span / points as i64 + 1
}
