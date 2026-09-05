#!/bin/sh
# 按 git tag 写入工作区版本号。发布流水线在 cargo build 之前调用，
# Agent 上报的版本、启动日志与 Release 的 tag 才是同一个数。
#
#   scripts/set-version.sh v1.2.3   # 写入 1.2.3
#   scripts/set-version.sh main     # 不是 v* tag，原样跳过
#
# 只认 v 开头带数字的 tag；手动触发或分支构建保持仓库里的 0.0.0，
# 这样非发布产物报出来的版本号自己就说明了来路。
set -eu

ref="${1:-}"
case "$ref" in
  v[0-9]*) ;;
  *)
    echo "版本号保持不变：'$ref' 不是 v* tag"
    exit 0
    ;;
esac

cd "$(dirname "$0")/.."
ver="${ref#v}"

# 根清单里只有 [workspace.package] 下那一处顶格的 version =，替换不会误伤依赖声明。
# 不用 sed -i：GNU 与 BSD 的 -i 语义不同，macOS runner 上会报错。
sed "s/^version = .*/version = \"$ver\"/" Cargo.toml > Cargo.toml.tmp
mv Cargo.toml.tmp Cargo.toml

# 成员版本号变了 Cargo.lock 就对不上，--locked 构建会直接失败，所以顺手同步一下：
# -w 只重算工作区成员，第三方依赖的锁定版本一个都不动。不加 --offline——
# runner 上的 registry 缓存可能是空的，离线解析会直接失败。
# 镜像那条线在容器里编、runner 上未必有 cargo，没有就跳过（Dockerfile 里没有 --locked，
# 容器内的 cargo 自己会把锁文件更新掉）。
if command -v cargo >/dev/null 2>&1; then
  cargo update --workspace
else
  echo "runner 上没有 cargo，Cargo.lock 留给容器内的构建更新"
fi

echo "版本号已写入 $ver"
