#!/usr/bin/env bash
# whatsapp-agent installer.
#
#   curl -fsSL https://raw.githubusercontent.com/dhurtado714/whatsapp-agent/main/install.sh | bash
#
# Downloads the right prebuilt binary for this machine, verifies its
# checksum, and installs it. Never uses sudo implicitly. Env overrides:
#   VERSION=vX.Y.Z    install a specific release instead of latest
#   INSTALL_DIR=/path install there instead of /usr/local/bin or ~/.local/bin
set -euo pipefail

REPO="dhurtado714/whatsapp-agent"

main() {
  local action="install"
  for arg in "$@"; do
    case "$arg" in
      --uninstall) action="uninstall" ;;
      --version) shift_next_is_version=1 ;;
      --dir) shift_next_is_dir=1 ;;
      *)
        if [ "${shift_next_is_version:-}" = "1" ]; then VERSION="$arg"; shift_next_is_version=0
        elif [ "${shift_next_is_dir:-}" = "1" ]; then INSTALL_DIR="$arg"; shift_next_is_dir=0
        fi
        ;;
    esac
  done

  local os arch asset dest
  os="$(detect_os)"
  arch="$(detect_arch "$os")"
  asset="whatsapp-agent-${os}-${arch}"
  dest="$(resolve_install_dir)/whatsapp-agent"

  if [ "$action" = "uninstall" ]; then
    if [ -f "$dest" ]; then
      rm -f "$dest"
      echo "Removed $dest"
    else
      echo "Nothing installed at $dest"
    fi
    exit 0
  fi

  local version="${VERSION:-latest}"
  local base_url
  if [ "$version" = "latest" ]; then
    base_url="https://github.com/${REPO}/releases/latest/download"
  else
    base_url="https://github.com/${REPO}/releases/download/${version}"
  fi

  # Deliberately not `local`: the EXIT trap below still needs to read this
  # after main() has returned, once the process is actually exiting, at
  # which point a `local` var's scope would already be gone — and with
  # `set -u`, referencing it then is a hard error instead of a no-op.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading ${asset}.tar.gz (${version})..."
  download "${base_url}/${asset}.tar.gz" "$tmp/${asset}.tar.gz"
  download "${base_url}/SHA256SUMS" "$tmp/SHA256SUMS"

  echo "Verifying checksum..."
  verify_checksum "$tmp" "${asset}.tar.gz"

  tar -xzf "$tmp/${asset}.tar.gz" -C "$tmp"
  local extracted="$tmp/${asset}"
  if [ ! -f "$extracted" ]; then
    # Fall back to whatever single file the tarball actually contains.
    extracted="$(find "$tmp" -maxdepth 1 -type f -name 'whatsapp-agent*' ! -name '*.tar.gz' | head -n1)"
  fi
  if [ -z "$extracted" ] || [ ! -f "$extracted" ]; then
    echo "Could not find the whatsapp-agent binary inside the downloaded archive." >&2
    exit 1
  fi

  local install_dir
  install_dir="$(resolve_install_dir)"
  if [ ! -w "$install_dir" ] && [ ! -w "$(dirname "$install_dir")" ]; then
    echo "Cannot write to $install_dir and it doesn't exist writable either." >&2
    echo "Install manually with:" >&2
    echo "  sudo install -m 755 \"$extracted\" /usr/local/bin/whatsapp-agent" >&2
    exit 1
  fi
  mkdir -p "$install_dir"
  install -m 755 "$extracted" "$dest"

  # Browser downloads get com.apple.quarantine; curl doesn't, but run this
  # defensively anyway in case the binary was relocated from one.
  if [ "$os" = "darwin" ]; then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
    codesign -s - "$dest" 2>/dev/null || true
  fi

  echo "Installed to $dest"
  "$dest" --version >/dev/null || {
    echo "Warning: $dest did not run successfully after install." >&2
    exit 1
  }

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      echo ""
      echo "$install_dir is not on your PATH. Add this to your shell profile:"
      if [ "$os" = "darwin" ]; then
        echo "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
      else
        echo "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
      fi
      ;;
  esac

  echo ""
  echo "Next: whatsapp-agent setup"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *)
      echo "Unsupported OS: $(uname -s). whatsapp-agent supports macOS and Linux only." >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  local os="$1"
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)
      if [ "$os" = "linux" ] && ! grep -q avx2 /proc/cpuinfo 2>/dev/null; then
        echo "x64-baseline"
      else
        echo "x64"
      fi
      ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

resolve_install_dir() {
  if [ -n "${INSTALL_DIR:-}" ]; then
    echo "$INSTALL_DIR"
  elif [ -w "/usr/local/bin" ]; then
    echo "/usr/local/bin"
  else
    echo "$HOME/.local/bin"
  fi
}

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    echo "Need curl or wget to download whatsapp-agent." >&2
    exit 1
  fi
}

verify_checksum() {
  local dir="$1" file="$2"
  (
    cd "$dir"
    if command -v sha256sum >/dev/null 2>&1; then
      grep " ${file}\$" SHA256SUMS | sha256sum -c -
    else
      grep " ${file}\$" SHA256SUMS | shasum -a 256 -c -
    fi
  ) || {
    echo "Checksum verification failed for ${file}. Aborting." >&2
    exit 1
  }
}

main "$@"
