# ---------- 阶段 1：构建前端（产物由 rust-embed 嵌入二进制） ----------
FROM oven/bun:1.3.14-alpine AS web

WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

COPY web/ ./
RUN bun run build

# ---------- 阶段 2：构建主控 ----------
FROM rust:1.98-slim-trixie AS build

# rusqlite 使用 bundled SQLite，需要 C 编译器
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY --from=web /web/dist web/dist

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p myprobe-server \
    && mkdir -p /out && cp target/release/myprobe-server /out/

# ---------- 阶段 3：运行时 ----------
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /home/myprobe myprobe \
    && mkdir -p /data && chown myprobe:myprobe /data

COPY --from=build /out/myprobe-server /usr/local/bin/myprobe-server

USER myprobe
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8000

# 数据目录固定在卷上；其余配置见 README（MYPROBE_ADDR / MYPROBE_ADMIN_PASSWORD / MYPROBE_JWT_SECRET ...）
ENV MYPROBE_DATA_DIR=/data \
    MYPROBE_ADDR=0.0.0.0:8000

ENTRYPOINT ["/usr/local/bin/myprobe-server"]
