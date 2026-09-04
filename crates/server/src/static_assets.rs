//! 托管前端静态资源。编译时把 web/dist 嵌入二进制，实现"单文件即整套系统"。

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::EmbeddedFile;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct Assets;

/// 静态文件服务（含 SPA fallback 到 index.html）。
pub async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(file) => respond(file, path),
        None => match Assets::get("index.html") {
            // 未匹配到资源时回退到前端入口（React Router 接管）
            Some(file) => respond(file, "index.html"),
            None => (StatusCode::NOT_FOUND, "前端尚未构建（需要先构建 web/dist）").into_response(),
        },
    }
}

fn respond(file: EmbeddedFile, path: &str) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // 前端 hash 资源可长缓存；入口与带无 hash 的 HTML 每次校验
    let cache = if mime == mime_guess::mime::TEXT_HTML {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}
