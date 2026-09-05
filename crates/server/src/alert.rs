//! 告警求值：资源阈值 / 延迟 / 宕机 / 到期。统一通过 NotifyService 通知。

use chrono::Timelike;
use myprobe_shared::protocol::{MetricsSample, ProbeResult};
use tokio::time::Duration;

use crate::models::{RenewCycle, Server, TrafficUsage};
use crate::state::{AlertAction, AppState, clear_traffic_alerts};

fn pct(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        used as f32 / total as f32 * 100.0
    }
}

/// 资源型告警求值。返回是否发生过一条通知。
pub async fn maybe_alert_metric(state: &AppState, srv: &Server, m: &MetricsSample) {
    let rules = state.db.get_alert_rules();
    if !(rules.cpu_enabled || rules.mem_enabled || rules.disk_enabled) {
        return;
    }

    let cpu = m.cpu_usage;
    let mem = pct(m.mem_used, m.mem_total);
    let disk_used: u64 = m.disks.iter().map(|d| d.used).sum();
    let disk_total: u64 = m.disks.iter().map(|d| d.total).sum();
    let disk = pct(disk_used, disk_total);

    let ts = timestamp(m.ts);

    // CPU
    if rules.cpu_enabled && rules.cpu_threshold > 0.0 {
        match state
            .alerts
            .threshold(&format!("cpu:{}", srv.id), cpu >= rules.cpu_threshold)
        {
            AlertAction::Fire => {
                notify(
                    state,
                    "🚨 <b>CPU 占用过高</b>",
                    &format!(
                        "服务器：{name}\n当前占用 <code>{cpu:.1}%</code>（阈值 {th:.0}%）\n时间：{ts}",
                        name = srv.name,
                        cpu = cpu,
                        th = rules.cpu_threshold,
                        ts = ts
                    ),
                )
                .await
            }
            AlertAction::Recover => {
                notify(
                    state,
                    "✅ <b>CPU 已恢复</b>",
                    &format!(
                        "服务器：{}\n当前占用 <code>{cpu:.1}%</code>\n时间：{ts}",
                        srv.name,
                        ts = ts
                    ),
                )
                .await
            }
            AlertAction::None => {}
        }
    }

    // 内存
    if rules.mem_enabled && rules.mem_threshold > 0.0 {
        match state.alerts.threshold(&format!("mem:{}", srv.id), mem >= rules.mem_threshold) {
            AlertAction::Fire => notify(
                state,
                "🚨 <b>内存占用过高</b>",
                &format!(
                    "服务器：{name}\n当前使用 <code>{mem:.1}%</code>（{used} / {total}，阈值 {th:.0}%）\n时间：{ts}",
                    name = srv.name,
                    mem = mem,
                    used = human_bytes(m.mem_used),
                    total = human_bytes(m.mem_total),
                    th = rules.mem_threshold,
                    ts = ts
                ),
            )
            .await,
            AlertAction::Recover => notify(
                state,
                "✅ <b>内存已恢复</b>",
                &format!(
                    "服务器：{}\n当前使用 <code>{mem:.1}%</code>\n时间：{ts}",
                    srv.name, mem = mem, ts = ts
                ),
            )
            .await,
            AlertAction::None => {}
        }
    }

    // 磁盘
    if rules.disk_enabled && rules.disk_threshold > 0.0 {
        match state.alerts.threshold(&format!("disk:{}", srv.id), disk >= rules.disk_threshold) {
            AlertAction::Fire => notify(
                state,
                "🚨 <b>磁盘占用过高</b>",
                &format!(
                    "服务器：{name}\n当前使用 <code>{disk:.1}%</code>（{used} / {total}，阈值 {th:.0}%）\n时间：{ts}",
                    name = srv.name,
                    disk = disk,
                    used = human_bytes(disk_used),
                    total = human_bytes(disk_total),
                    th = rules.disk_threshold,
                    ts = ts
                ),
            )
            .await,
            AlertAction::Recover => notify(
                state,
                "✅ <b>磁盘已恢复</b>",
                &format!("服务器：{}\n当前使用 <code>{disk:.1}%</code>\n时间：{ts}", srv.name, disk = disk, ts = ts),
            )
            .await,
            AlertAction::None => {}
        }
    }
}

/// 延迟告警求值：失败或超过阈值时触发（阈值告警用 threshold 去重）。
pub async fn maybe_alert_probe(state: &AppState, srv: &Server, r: &ProbeResult) {
    let rules = state.db.get_alert_rules();
    if !rules.latency_enabled {
        return;
    }

    let ts = timestamp(r.ts);

    if let Some(lat) = r.latency_ms {
        let above = lat >= rules.latency_threshold_ms as f64;
        match state
            .alerts
            .threshold(&format!("lat:{}:{}", srv.id, r.probe_id), above)
        {
            AlertAction::Fire => {
                noti_probe(state, srv, r, &format!(
                    "🚨 <b>延迟过高</b>\n服务器：{}（探测 {}）\n延迟 <code>{lat:.0} ms</code>（阈值 {th} ms）\n时间：{ts}",
                    srv.name, probe_name(state, r.probe_id), lat = lat, th = rules.latency_threshold_ms, ts = ts
                )).await;
            }
            AlertAction::Recover => {
                noti_probe(state, srv, r, &format!(
                    "✅ <b>延迟已恢复</b>\n服务器：{}（探测 {}）\n当前 <code>{lat:.0} ms</code>\n时间：{ts}",
                    srv.name, probe_name(state, r.probe_id), lat = lat, ts = ts
                )).await;
            }
            AlertAction::None => {}
        }
    } else if !r.ok {
        // 探测失败（目标不可达）
        let stamp = format!("{}:{}", r.probe_id, r.ts);
        if state.alerts.once(&format!("probe_down:{}:{}", srv.id, stamp)) {
            noti_probe(
                state,
                srv,
                r,
                &format!(
                    "⚠️ <b>探测失败</b>\n服务器：{}（探测 {}）\n错误：{}\n时间：{ts}",
                    srv.name,
                    probe_name(state, r.probe_id),
                    r.error.as_deref().unwrap_or("未知"),
                    ts = ts
                ),
            )
            .await;
        }
    }
}

/// 流量告警求值。阈值是全局的（和 CPU/内存/磁盘一致），限额按机器配。
///
/// 「快到量」和「已到量」是两件事，分两个去重键各发一条；周期重置由调用方
/// 清键（`clear_traffic_alerts`），所以新周期能重新触发。
pub async fn maybe_alert_traffic(state: &AppState, srv: &Server, u: &TrafficUsage, rolled: bool) {
    let rules = state.db.get_alert_rules();
    let limit = srv.traffic.limit_bytes;
    if !rules.traffic_enabled || limit == 0 {
        if rolled {
            clear_traffic_alerts(state, srv.id);
        }
        return;
    }

    let used = srv.traffic.mode.used(u.rx, u.tx);
    let ratio = pct(used, limit);
    let th = rules.traffic_threshold_pct.clamp(1.0, 100.0);
    let ts = timestamp(u.updated_at);
    let detail = format!(
        "服务器：{name}\n本周期已用 <code>{used}</code> / {limit}（{ratio:.1}%，计费口径 {mode}）\n时间：{ts}",
        name = srv.name,
        used = human_bytes(used),
        limit = human_bytes(limit),
        mode = srv.traffic.mode.label(),
        ratio = ratio,
        ts = ts,
    );

    match state
        .alerts
        .threshold(&format!("traffic:{}", srv.id), ratio >= th)
    {
        AlertAction::Fire => {
            notify(
                state,
                "🚨 <b>流量即将用尽</b>",
                &format!("{detail}\n阈值 {th:.0}%"),
            )
            .await
        }
        AlertAction::Recover => {
            notify(state, "✅ <b>流量已回落</b>", &format!("{detail}\n阈值 {th:.0}%")).await
        }
        AlertAction::None => {}
    }

    // 到量单独发一条，且同一周期只发一次
    if ratio >= 100.0 && state.alerts.once(&format!("traffic-full:{}", srv.id)) {
        notify(state, "🛑 <b>流量已用完</b>", &detail).await;
    }

    // 归零那一笔求值完再清键：上面刚好把「已回落」发出去，之后新周期能重新触发
    if rolled {
        clear_traffic_alerts(state, srv.id);
    }
}

/// 离线 / 恢复通知。
pub async fn notify_offline(state: &AppState, srv: &Server, offline: bool) {
    let rules = state.db.get_alert_rules();
    if !rules.offline_enabled {
        return;
    }
    let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    match state.alerts.threshold(&format!("offline:{}", srv.id), offline) {
        AlertAction::Fire => {
            notify(
                state,
                "🔴 <b>服务器已离线</b>",
                &format!("服务器：{}\n已失去响应。\n时间：{ts}", srv.name, ts = ts),
            )
            .await;
        }
        AlertAction::Recover => {
            notify(
                state,
                "🟢 <b>服务器已恢复</b>",
                &format!("服务器：{}\n已重新连接。\n时间：{ts}", srv.name, ts = ts),
            )
            .await;
        }
        AlertAction::None => {}
    }
}

/// 到期提醒（每天扫描一次）。
pub async fn daily_expiry_scan(state: &AppState) {
    let rules = state.db.get_alert_rules();
    if !rules.expire_enabled {
        return;
    }
    for srv in state.db.list_servers() {
        let Some(days) = srv.days_to_expire() else {
            continue;
        };
        let Some(expire) = &srv.expire_date else { continue };
        if days > rules.expire_days as i64 {
            continue;
        }
        // 已过期才播报一次"已到期"；临期则每天播报一次。
        let title = if days < 0 {
            format!("⛔ <b>{}</b> 已到期", html_escape(&srv.name))
        } else if days == 0 {
            format!("⏰ <b>{}</b> 今天到期", html_escape(&srv.name))
        } else {
            format!("📅 <b>{}</b> 即将到期", html_escape(&srv.name))
        };
        let dedup = format!("expire:{id}:{date}", id = srv.id, date = expire);
        if state.alerts.once(&dedup) {
            // 币种只报三字母码：符号表放前端就够了，通知里写 code 反而不会有歧义。
            // 免费机器单独一句，否则会出现「续费价：0.00 CNY / 免费」这种废话
            let cost = if srv.renew_cycle == RenewCycle::Free {
                "免费".to_string()
            } else {
                format!(
                    "{price:.2} {code} / {cycle}",
                    price = srv.renew_price,
                    code = srv.currency,
                    cycle = srv.renew_cycle.label()
                )
            };
            let msg = format!("{title}\n到期日：{expire}\n剩余：{days} 天\n续费价：{cost}");
            state.notify.broadcast("到期提醒", &msg).await;
        }
    }
}

/// 每日定时任务：清理昨日到期提醒的防重 key，并重新扫描。
pub async fn run_daily_tasks(state: AppState) {
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        let now = chrono::Utc::now();
        // 每天在 8:00-9:00 之间执行一次。
        if now.hour() == 8 {
            daily_expiry_scan(&state).await;
            crate::state::clear_timed_alerts(&state);
        }
    }
}

// ---------- 辅助 ----------

async fn notify(state: &AppState, title: &str, message: &str) {
    state.notify.broadcast(title, message).await;
}

async fn noti_probe(state: &AppState, srv: &Server, _r: &ProbeResult, text: &str) {
    let _ = srv;
    state.notify.broadcast("延迟探测", text).await;
}

fn probe_name(state: &AppState, probe_id: i64) -> String {
    state
        .db
        .get_probe(probe_id)
        .map(|p| p.name)
        .unwrap_or_else(|| format!("#{probe_id}"))
}

fn timestamp(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "未知时间".to_string())
}

fn human_bytes(b: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    format!("{v:.1} {}", UNITS[u])
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
