//! SQLite 持久层。使用 rusqlite bundled，单文件、无外部依赖。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use myprobe_shared::protocol::{ProbeProtocol, ProbeResult};
use rusqlite::{Connection, OptionalExtension, params};

use crate::models::{
    AlertRules, LatencyBand, LatencyScheme, MetricPoint, NotifierConfig, Probe, ProbePoint, RenewCycle,
    Server, ServerAttrs, TrafficBump, TrafficMode, TrafficPlan, TrafficUsage, default_latency_bands,
};

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
    last_seen    INTEGER NOT NULL DEFAULT 0,
    agent_version TEXT,
    -- 月流量限额（字节），0 = 不限制
    traffic_limit_bytes INTEGER NOT NULL DEFAULT 0,
    -- 计费口径：up / down / sum / max
    traffic_mode TEXT NOT NULL DEFAULT 'sum',
    -- 每月重置日 1-28，0 = 不重置
    traffic_reset_day INTEGER NOT NULL DEFAULT 1,
    -- 永不到期（自建 / 一次性买断），置 1 时忽略 expire_date
    never_expire INTEGER NOT NULL DEFAULT 0,
    -- 续费价格的币种，ISO 4217 三字母码
    currency     TEXT NOT NULL DEFAULT 'CNY',
    -- 列表手工排序，小的在前；相同时按 id
    sort_order   INTEGER NOT NULL DEFAULT 0
);

-- 当前计费周期的流量累计。last_rx/last_tx 是上一次上报的累计读数，只用来做差分。
CREATE TABLE IF NOT EXISTS traffic_usage (
    server_id   INTEGER PRIMARY KEY,
    cycle_start INTEGER NOT NULL DEFAULT 0,
    rx          INTEGER NOT NULL DEFAULT 0,
    tx          INTEGER NOT NULL DEFAULT 0,
    last_rx     INTEGER NOT NULL DEFAULT 0,
    last_tx     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- 归档：每次周期重置时把上一周期写进来，用来看「上个月用了多少」。
CREATE TABLE IF NOT EXISTS traffic_history (
    server_id   INTEGER NOT NULL,
    cycle_start INTEGER NOT NULL,
    rx          INTEGER NOT NULL DEFAULT 0,
    tx          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(server_id, cycle_start),
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- 命名延迟配色方案：多个探测目标共用一套阈值，改方案就等于改所有引用它的目标。
CREATE TABLE IF NOT EXISTS latency_schemes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    bands       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
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
    created_at  TEXT NOT NULL,
    -- 延迟配色分段（JSON 数组）。NULL 表示往下回退到方案 / settings.latency_bands_default
    latency_bands TEXT,
    -- 引用的命名方案。方案删除时置空，于是自动回退到全局默认
    latency_scheme_id INTEGER REFERENCES latency_schemes(id) ON DELETE SET NULL
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

/// servers 的完整列清单。三处查询共用，列序与 `row_to_server` 的下标一一对应。
const SERVER_COLS: &str = "id, name, secret, country, note, enabled, expire_date,
     renew_price, renew_cycle, report_interval_s, created_at, last_seen, agent_version,
     traffic_limit_bytes, traffic_mode, traffic_reset_day, never_expire, currency";

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
        migrate_servers(&conn)?;
        migrate_probe_cols(&conn)?;
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

    /// 全局默认延迟配色。探测目标没单独配置时用它。
    pub fn get_latency_bands_default(&self) -> Vec<LatencyBand> {
        self.get_setting("latency_bands_default")
            .and_then(|s| serde_json::from_str::<Vec<LatencyBand>>(&s).ok())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(default_latency_bands)
    }

    pub fn set_latency_bands_default(&self, bands: &[LatencyBand]) -> rusqlite::Result<()> {
        self.set_setting("latency_bands_default", &serde_json::to_string(bands).unwrap())
    }

    // ---------- 命名配色方案 ----------

    /// 全部方案，按手工顺序（sort_order 相同再按 id）。
    pub fn list_latency_schemes(&self) -> Vec<LatencyScheme> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT id, name, bands FROM latency_schemes ORDER BY sort_order, id")
            .unwrap();
        stmt.query_map([], row_to_scheme)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_latency_scheme(&self, id: i64) -> Option<LatencyScheme> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT id, name, bands FROM latency_schemes WHERE id=?1",
            params![id],
            row_to_scheme,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// 新方案排在末尾：sort_order 取当前最大值 +1。
    pub fn create_latency_scheme(&self, name: &str, bands: &[LatencyBand]) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO latency_schemes(name, bands, sort_order, created_at)
             VALUES(?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM latency_schemes), ?3)",
            params![name, serde_json::to_string(bands).unwrap(), Self::now_iso()],
        )?;
        Ok(c.last_insert_rowid())
    }

    pub fn update_latency_scheme(&self, id: i64, name: &str, bands: &[LatencyBand]) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE latency_schemes SET name=?2, bands=?3 WHERE id=?1",
            params![id, name, serde_json::to_string(bands).unwrap()],
        )?;
        Ok(())
    }

    /// 删除方案。引用它的探测目标由外键置空，于是自动回退到全局默认。
    pub fn delete_latency_scheme(&self, id: i64) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM latency_schemes WHERE id=?1", params![id])?;
        Ok(())
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
            .prepare(&format!("SELECT {SERVER_COLS} FROM servers ORDER BY sort_order, id"))
            .unwrap();
        stmt.query_map([], row_to_server)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_server(&self, id: i64) -> Option<Server> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            &format!("SELECT {SERVER_COLS} FROM servers WHERE id = ?1"),
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
            &format!("SELECT {SERVER_COLS} FROM servers WHERE secret = ?1"),
            params![secret],
            row_to_server,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// 新建机器。可编辑字段打包成 `ServerAttrs`（见 models.rs），十几个位置参数太容易错位。
    /// `sort_order` 直接在 SQL 里取当前最大值 +1，新机器排在列表末尾，省一次查询。
    pub fn create_server(&self, secret: &str, a: &ServerAttrs) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO servers(name, secret, country, note, expire_date, never_expire, currency,
                                 renew_price, renew_cycle, report_interval_s, created_at,
                                 traffic_limit_bytes, traffic_mode, traffic_reset_day, sort_order)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM servers))",
            params![
                a.name,
                secret,
                a.country,
                a.note,
                a.expire_date,
                a.never_expire as i64,
                a.currency,
                a.renew_price,
                a.renew_cycle.as_str(),
                a.report_interval_s as i64,
                Self::now_iso(),
                a.traffic.limit_bytes as i64,
                a.traffic.mode.as_str(),
                a.traffic.reset_day as i64
            ],
        )?;
        Ok(c.last_insert_rowid())
    }

    /// `enabled` 不在 `ServerAttrs` 里：新建时恒为启用，只有更新才会改它。
    pub fn update_server(&self, id: i64, enabled: bool, a: &ServerAttrs) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE servers SET name=?1, country=?2, note=?3, enabled=?4, expire_date=?5,
                    never_expire=?6, currency=?7, renew_price=?8, renew_cycle=?9,
                    report_interval_s=?10, traffic_limit_bytes=?11, traffic_mode=?12,
                    traffic_reset_day=?13
             WHERE id=?14",
            params![
                a.name,
                a.country,
                a.note,
                enabled as i64,
                a.expire_date,
                a.never_expire as i64,
                a.currency,
                a.renew_price,
                a.renew_cycle.as_str(),
                a.report_interval_s as i64,
                a.traffic.limit_bytes as i64,
                a.traffic.mode.as_str(),
                a.traffic.reset_day as i64,
                id
            ],
        )?;
        Ok(())
    }

    /// 按给定 id 顺序重排列表，一个事务写完，中途失败不会留下半套顺序。
    /// 没出现在 ids 里的机器保持原值，由 `ORDER BY sort_order, id` 兜底。
    pub fn reorder_servers(&self, ids: &[i64]) -> rusqlite::Result<()> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE servers SET sort_order=?1 WHERE id=?2")?;
            for (i, id) in ids.iter().enumerate() {
                stmt.execute(params![i as i64 + 1, id])?;
            }
        }
        tx.commit()
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

    /// 记录 Agent 上报的版本号，用于后台看出哪台还没更新。
    pub fn set_agent_version(&self, id: i64, version: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "UPDATE servers SET agent_version=?1 WHERE id=?2",
            params![version, id],
        );
    }

    pub fn rotate_secret(&self, id: i64, secret: &str) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute("UPDATE servers SET secret=?1 WHERE id=?2", params![secret, id])?;
        Ok(())
    }

    // ---------- traffic ----------

    /// 记一次上报带来的流量增量，返回落库后的当前周期用量。
    ///
    /// Agent 给的是累计读数，起点语义不确定，所以这里只信差值：
    /// `delta = cur - last`；任一方向出现 `cur < last`（Agent 重启 / 机器重启 /
    /// 计数回绕）就只把基线挪到新读数、这一轮不累加，避免把整个累计值当成增量。
    /// 首次见到一台机器同样只建基线。`cycle_start` 变新则先归档旧周期再归零。
    pub fn bump_traffic(
        &self,
        server_id: i64,
        cur_rx: u64,
        cur_tx: u64,
        cycle_start: i64,
        now: i64,
    ) -> rusqlite::Result<TrafficBump> {
        let mut c = self.conn.lock().unwrap();
        let t = c.transaction()?;
        let old = t
            .query_row(
                "SELECT cycle_start, rx, tx, last_rx, last_tx, updated_at FROM traffic_usage WHERE server_id=?1",
                params![server_id],
                row_to_traffic,
            )
            .optional()?;

        let existed = old.is_some();
        let mut u = old.unwrap_or(TrafficUsage {
            cycle_start,
            ..Default::default()
        });

        // 跨周期：把上一周期存进归档表，再把计数归零
        let rolled = existed && u.cycle_start < cycle_start;
        if rolled {
            if u.cycle_start > 0 && (u.rx > 0 || u.tx > 0) {
                t.execute(
                    "INSERT INTO traffic_history(server_id, cycle_start, rx, tx) VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(server_id, cycle_start) DO UPDATE SET rx = excluded.rx, tx = excluded.tx",
                    params![server_id, u.cycle_start, u.rx as i64, u.tx as i64],
                )?;
            }
            u.cycle_start = cycle_start;
            u.rx = 0;
            u.tx = 0;
        }

        // last 全为 0 视为「还没有基线」：可能是刚建行，也可能是手动校正过
        let fresh = u.last_rx == 0 && u.last_tx == 0;
        let rollback = cur_rx < u.last_rx || cur_tx < u.last_tx;
        if !fresh && !rollback {
            u.rx = u.rx.saturating_add(cur_rx - u.last_rx);
            u.tx = u.tx.saturating_add(cur_tx - u.last_tx);
        }
        u.last_rx = cur_rx;
        u.last_tx = cur_tx;
        u.updated_at = now;

        t.execute(
            "INSERT INTO traffic_usage(server_id, cycle_start, rx, tx, last_rx, last_tx, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(server_id) DO UPDATE SET
                cycle_start = excluded.cycle_start, rx = excluded.rx, tx = excluded.tx,
                last_rx = excluded.last_rx, last_tx = excluded.last_tx, updated_at = excluded.updated_at",
            params![
                server_id,
                u.cycle_start,
                u.rx as i64,
                u.tx as i64,
                u.last_rx as i64,
                u.last_tx as i64,
                u.updated_at
            ],
        )?;
        t.commit()?;
        Ok(TrafficBump { usage: u, rolled })
    }

    /// 全部机器的当前周期用量。列表页一次查完，避免每台一条 SQL。
    pub fn all_traffic(&self) -> HashMap<i64, TrafficUsage> {
        let c = self.conn.lock().unwrap();
        let Ok(mut stmt) = c.prepare(
            "SELECT server_id, cycle_start, rx, tx, last_rx, last_tx, updated_at FROM traffic_usage",
        ) else {
            return HashMap::new();
        };
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, row_to_traffic_at(r, 1)?)));
        match rows {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => HashMap::new(),
        }
    }

    pub fn get_traffic(&self, server_id: i64) -> TrafficUsage {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT cycle_start, rx, tx, last_rx, last_tx, updated_at FROM traffic_usage WHERE server_id=?1",
            params![server_id],
            row_to_traffic,
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default()
    }

    /// 手动校正：把当前周期已用量改成 `used_bytes`（None = 归零）。
    ///
    /// 按口径反推 rx/tx：能保持原来的上下行比例就按比例缩放，否则整个记到
    /// 计费方向上。基线 `last_rx/last_tx` 一并清零，下一次上报重新建基线 ——
    /// 换机 / Agent 长期离线后累计读数已经没有可比性了。
    pub fn reset_traffic(
        &self,
        server_id: i64,
        cycle_start: i64,
        used_bytes: Option<u64>,
        mode: TrafficMode,
        now: i64,
    ) -> rusqlite::Result<TrafficUsage> {
        let old = self.get_traffic(server_id);
        let target = used_bytes.unwrap_or(0);
        let old_used = mode.used(old.rx, old.tx);
        let (rx, tx) = if target == 0 {
            (0, 0)
        } else if old_used > 0 {
            let scale = |v: u64| (v as u128 * target as u128 / old_used as u128) as u64;
            (scale(old.rx), scale(old.tx))
        } else if mode == TrafficMode::Up {
            (0, target)
        } else {
            (target, 0)
        };

        let u = TrafficUsage {
            cycle_start,
            rx,
            tx,
            last_rx: 0,
            last_tx: 0,
            updated_at: now,
        };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO traffic_usage(server_id, cycle_start, rx, tx, last_rx, last_tx, updated_at)
             VALUES(?1, ?2, ?3, ?4, 0, 0, ?5)
             ON CONFLICT(server_id) DO UPDATE SET
                cycle_start = excluded.cycle_start, rx = excluded.rx, tx = excluded.tx,
                last_rx = 0, last_tx = 0, updated_at = excluded.updated_at",
            params![server_id, cycle_start, rx as i64, tx as i64, now],
        )?;
        Ok(u)
    }

    /// 已归档的历史周期，按时间倒序。
    pub fn traffic_cycles(&self, server_id: i64, limit: i64) -> Vec<(i64, u64, u64)> {
        let c = self.conn.lock().unwrap();
        let Ok(mut stmt) = c.prepare(
            "SELECT cycle_start, rx, tx FROM traffic_history
             WHERE server_id=?1 ORDER BY cycle_start DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![server_id, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?.max(0) as u64,
                r.get::<_, i64>(2)?.max(0) as u64,
            ))
        });
        match rows {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    // ---------- probes ----------

    /// 全部探测目标（后台探测列表）。
    pub fn list_probes(&self) -> Vec<Probe> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare(
                "SELECT id, name, target, protocol, port, timeout_ms, interval_s, enabled, latency_bands,
                        latency_scheme_id
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
                "SELECT p.id, p.name, p.target, p.protocol, p.port, p.timeout_ms, p.interval_s, p.enabled,
                        p.latency_bands, p.latency_scheme_id
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
            "SELECT id, name, target, protocol, port, timeout_ms, interval_s, enabled, latency_bands,
                    latency_scheme_id
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
        bands: Option<&[LatencyBand]>,
        scheme_id: Option<i64>,
    ) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO probes(name, target, protocol, port, timeout_ms, interval_s, enabled, created_at,
                                latency_bands, latency_scheme_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                name,
                target,
                protocol.as_str(),
                port,
                timeout_ms as i64,
                interval_s as i64,
                enabled as i64,
                Self::now_iso(),
                bands_json(bands),
                scheme_id
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
        bands: Option<&[LatencyBand]>,
        scheme_id: Option<i64>,
    ) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE probes SET name=?1, target=?2, protocol=?3, port=?4, timeout_ms=?5, interval_s=?6,
                    enabled=?7, latency_bands=?9, latency_scheme_id=?10
             WHERE id=?8",
            params![
                name,
                target,
                protocol.as_str(),
                port,
                timeout_ms as i64,
                interval_s as i64,
                enabled as i64,
                id,
                bands_json(bands),
                scheme_id
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
        agent_version: r.get(12)?,
        traffic: TrafficPlan {
            limit_bytes: r.get::<_, i64>(13)?.max(0) as u64,
            mode: TrafficMode::parse(&r.get::<_, String>(14)?),
            reset_day: r.get::<_, i64>(15)?.clamp(0, 28) as u32,
        },
        never_expire: r.get::<_, i64>(16)? != 0,
        currency: r.get(17)?,
        online: false,
    })
}

fn row_to_traffic(r: &rusqlite::Row) -> rusqlite::Result<TrafficUsage> {
    row_to_traffic_at(r, 0)
}

/// 同上，但列从 `off` 开始（`all_traffic` 在前面多带了一列 server_id）。
fn row_to_traffic_at(r: &rusqlite::Row, off: usize) -> rusqlite::Result<TrafficUsage> {
    Ok(TrafficUsage {
        cycle_start: r.get(off)?,
        rx: r.get::<_, i64>(off + 1)?.max(0) as u64,
        tx: r.get::<_, i64>(off + 2)?.max(0) as u64,
        last_rx: r.get::<_, i64>(off + 3)?.max(0) as u64,
        last_tx: r.get::<_, i64>(off + 4)?.max(0) as u64,
        updated_at: r.get(off + 5)?,
    })
}

/// 分段配色写库前序列化；None（跟随全局默认）落成 SQL NULL。
fn bands_json(bands: Option<&[LatencyBand]>) -> Option<String> {
    bands.map(|b| serde_json::to_string(b).unwrap_or_default())
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
        // 解析不出来就当没配（继续往下回退），不因为一行坏数据让整张列表报错
        latency_bands: r
            .get::<_, Option<String>>(8)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        latency_scheme_id: r.get(9)?,
    })
}

/// bands 解析不出来就当空数组：配色解析会继续往下回退，坏数据不至于挡住整张方案列表。
fn row_to_scheme(r: &rusqlite::Row) -> rusqlite::Result<LatencyScheme> {
    Ok(LatencyScheme {
        id: r.get(0)?,
        name: r.get(1)?,
        bands: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
    })
}

/// 表是否已有某一列。加列式迁移都走它，避免重复 ALTER 报错。
fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(cols.iter().any(|c| c == column))
}

/// servers 表的加列式迁移。
fn migrate_servers(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "servers", "agent_version")? {
        tracing::info!("迁移数据库：servers 增加 agent_version 列");
        conn.execute_batch("ALTER TABLE servers ADD COLUMN agent_version TEXT")?;
    }
    if !has_column(conn, "servers", "traffic_limit_bytes")? {
        tracing::info!("迁移数据库：servers 增加流量限额三列");
        conn.execute_batch(
            "ALTER TABLE servers ADD COLUMN traffic_limit_bytes INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE servers ADD COLUMN traffic_mode TEXT NOT NULL DEFAULT 'sum';
             ALTER TABLE servers ADD COLUMN traffic_reset_day INTEGER NOT NULL DEFAULT 1;",
        )?;
    }
    // 三列一起加：都是这一版新增的资产字段，一步迁移少一次 PRAGMA 探测
    if !has_column(conn, "servers", "sort_order")? {
        tracing::info!("迁移数据库：servers 增加 never_expire / currency / sort_order 列");
        conn.execute_batch(
            "ALTER TABLE servers ADD COLUMN never_expire INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE servers ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY';
             ALTER TABLE servers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
             -- 老库没有手工顺序，按 id 铺一遍，保持迁移前后的列表顺序一致
             UPDATE servers SET sort_order = id WHERE sort_order = 0;",
        )?;
    }
    Ok(())
}

/// probes 表的加列式迁移。放在 migrate_probes 之后跑：老库先重建成新结构，再补列。
fn migrate_probe_cols(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "probes", "latency_bands")? {
        tracing::info!("迁移数据库：probes 增加 latency_bands 列");
        conn.execute_batch("ALTER TABLE probes ADD COLUMN latency_bands TEXT")?;
    }
    // 带 REFERENCES 的加列只允许默认 NULL，正好就是「没引用方案」的含义
    if !has_column(conn, "probes", "latency_scheme_id")? {
        tracing::info!("迁移数据库：probes 增加 latency_scheme_id 列");
        conn.execute_batch(
            "ALTER TABLE probes ADD COLUMN latency_scheme_id INTEGER
             REFERENCES latency_schemes(id) ON DELETE SET NULL",
        )?;
    }
    Ok(())
}

/// 旧版本的探测目标直接挂在服务器下（probes.server_id）。这里把它拆成
/// 独立的 probes + probe_assignments，老数据按原归属生成一条指派记录。
fn migrate_probes(conn: &Connection) -> rusqlite::Result<()> {
    let legacy = has_column(conn, "probes", "server_id")?;
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
