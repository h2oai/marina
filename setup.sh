#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Marina setup: one command from nothing to a running Marina.
#
#   curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash
#
# It installs Bun if needed (Bun's official installer, into ~/.bun), downloads Marina into
# ~/marina, installs its packages, builds the dashboard, puts `marina` on your PATH, asks for one
# thing (a model API key, Enter to skip), then starts Marina and opens it in your browser.
# Run it again to update; your settings and world are kept.
#
# Options (after `bash -s --` when piped):
#   --dir <path>   install here instead of ~/marina (or set MARINA_DIR)
#   --yes          ask nothing and do not start Marina: for AI agents and scripts
#   --no-start     set up, but do not start Marina at the end
#   --no-modify-path  leave your shell's startup file alone
#   --help         this text
#
# It never uses sudo. Outside the install folder it changes only ~/.bun (Bun), the `marina` link,
# and one PATH line in your shell's startup file when `marina` would not be found otherwise.

set -euo pipefail

# Everything runs from main(), called on the last line, so a download cut short runs nothing.
main() {
  local dir="${MARINA_DIR:-$HOME/marina}"
  local assume_yes=0 start=1 modify_path=1
  local repo="${MARINA_SETUP_REPO:-https://github.com/h2oai/marina.git}"
  local ref="${MARINA_SETUP_REF:-main}"

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="${2:?--dir needs a folder}"; shift 2 ;;
      --dir=*) dir="${1#--dir=}"; shift ;;
      --yes|-y) assume_yes=1; start=0; shift ;;
      --no-start) start=0; shift ;;
      --no-modify-path) modify_path=0; shift ;;
      --help|-h) usage; return 0 ;;
      *) fail "Unknown option: $1 (try --help)" ;;
    esac
  done

  # No terminal to answer on (an agent, CI, a pipe with no tty): ask nothing.
  if [ "$assume_yes" -eq 0 ] && ! { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null; then
    assume_yes=1
    start=0
  fi

  case "$(uname -s)" in
    Linux|Darwin) ;;
    MINGW*|MSYS*|CYGWIN*)
      fail "On Windows, run this inside WSL (https://learn.microsoft.com/windows/wsl/install), or use Docker (see the README)." ;;
    *) fail "Unsupported system: $(uname -s). Marina runs on Linux and macOS." ;;
  esac
  need curl "Install curl with your system's package manager, then run this again."
  need tar "Install tar with your system's package manager, then run this again."

  say "Setting up Marina in $dir"

  step "1/5" "Downloading Marina"
  fetch_marina "$repo" "$ref" "$dir"
  cd "$dir"

  step "2/5" "Checking Bun (the runtime Marina uses)"
  local bun
  bun="$(ensure_bun "$(tr -d '[:space:]' <.bun-version)")"

  step "3/5" "Installing packages (a minute or two)"
  "$bun" install --no-progress >/dev/null || "$bun" install

  step "4/5" "Building the dashboard"
  "$bun" run dashboard:build >/dev/null 2>&1 || "$bun" run dashboard:build

  step "5/5" "Putting marina on your PATH"
  "$bun" --no-env-file scripts/setup-cli.ts >/dev/null
  local link_dir
  link_dir="$(marina_link_dir "$bun")"
  # `marina` runs on `bun`, so both folders must be on PATH.
  if [ "$modify_path" -eq 1 ]; then
    add_to_path "$link_dir" "$(dirname "$bun")"
  else
    say "  marina is in $link_dir; it needs $(dirname "$bun") on PATH too."
  fi

  if [ "$assume_yes" -eq 1 ]; then
    "$bun" --no-env-file scripts/marina.ts init --yes | sed 's/^/  /'
  else
    "$bun" --no-env-file scripts/marina.ts init </dev/tty
  fi

  local url="http://localhost:${WS_PORT:-3300}"
  if [ "$start" -eq 1 ]; then
    say ""
    say "Starting Marina. It opens in your browser at $url"
    say "Keep this window open while you use it; close it (or press Ctrl+C) to stop."
    say "To start it again later, open a new terminal and type: marina start"
    open_when_ready "$url" &
    exec "$bun" --no-env-file scripts/marina.ts start </dev/tty
  fi

  say ""
  say "Marina is installed in $dir."
  say "Start it: open a new terminal window and type  marina start"
  say "Then open $url. With no model key yet, add one in the dashboard: Admin, then Keys."
}

usage() {
  cat <<'USAGE'
Marina setup: installs Bun if needed, downloads Marina, builds it, puts `marina` on your PATH,
asks for a model API key (Enter to skip), then starts Marina and opens it in your browser.

  curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash
  curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash -s -- --yes

  --dir <path>   install here instead of ~/marina (or set MARINA_DIR)
  --yes          ask nothing and do not start Marina: for AI agents and scripts
  --no-start     set up, but do not start Marina at the end
  --no-modify-path  do not add marina's folder to your shell's startup file
  --help         this text
USAGE
}
say() { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
fail() { printf 'Marina setup stopped: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"; }

# The folder setup-cli linked `marina` into (the first of ~/.bun/bin and ~/.local/bin on PATH,
# else Bun's).
marina_link_dir() {
  local bun="$1" d
  for d in "${BUN_INSTALL:-$HOME/.bun}/bin" "$HOME/.local/bin"; do
    if [ -L "$d/marina" ] && case ":$PATH:" in *":$d:"*) true ;; *) false ;; esac; then
      printf '%s\n' "$d"; return
    fi
  done
  printf '%s\n' "${BUN_INSTALL:-$HOME/.bun}/bin"
}

# Make `marina` (and the `bun` it runs on) found in new terminals: add each folder that is not
# on PATH to the shell's startup file once, unless the file already names it.
add_to_path() {
  local rc shell_name d added=0
  shell_name="$(basename "${SHELL:-bash}")"
  case "$shell_name" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    *) rc="$HOME/.profile" ;;
  esac
  for d in "$@"; do
    case ":$PATH:" in *":$d:"*) continue ;; esac
    if [ -f "$rc" ] && grep -qF "$d" "$rc"; then continue; fi
    mkdir -p "$(dirname "$rc")"
    if [ "$shell_name" = fish ]; then
      printf '\n# Added by Marina setup\nfish_add_path %s\n' "$d" >>"$rc"
    else
      printf '\n# Added by Marina setup\nexport PATH="%s:$PATH"\n' "$d" >>"$rc"
    fi
    say "  Added $d to your PATH in $rc."
    added=1
  done
  if [ "$added" -eq 0 ]; then say "  marina is ready in new terminals."; fi
}

# git works only when it is really installed: on a Mac without the developer tools, `git`
# is a stub that opens an installer dialog, so a tarball is used instead.
have_git() {
  command -v git >/dev/null 2>&1 || return 1
  if [ "$(uname -s)" = Darwin ]; then xcode-select -p >/dev/null 2>&1 || return 1; fi
  return 0
}

fetch_marina() {
  local repo="$1" ref="$2" dir="$3"
  if [ -d "$dir/.git" ]; then
    if have_git && git -C "$dir" pull --ff-only --quiet origin "$ref"; then
      say "  Updated to the latest version."
    else
      say "  Could not update; keeping the version already here."
    fi
    return
  fi
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] && [ ! -f "$dir/.bun-version" ]; then
    fail "$dir already exists and is not Marina. Choose another folder with --dir <path>."
  fi
  if [ ! -e "$dir" ] && have_git; then
    git clone --quiet --depth 1 --branch "$ref" "$repo" "$dir"
    return
  fi
  # No git, or an earlier tarball install to update: unpack over it (settings and data are not
  # in the archive, so they are kept).
  local tmp
  tmp="$(mktemp -d)"
  local archive="https://codeload.github.com/h2oai/marina/tar.gz/refs/heads/$ref"
  curl -fsSL "$archive" | tar -xz -C "$tmp" || fail "Could not download Marina from $archive"
  mkdir -p "$dir"
  cp -R "$tmp"/*/. "$dir"/
  rm -rf "$tmp"
}

# Print the path of a Bun at least version $1, installing it with Bun's official installer when
# missing or older.
ensure_bun() {
  local want="$1" bun=""
  if command -v bun >/dev/null 2>&1; then bun="$(command -v bun)"
  elif [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then bun="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
  fi
  if [ -n "$bun" ] && version_at_least "$("$bun" --version)" "$want"; then
    printf '  Bun %s found.\n' "$("$bun" --version)" >&2
    printf '%s\n' "$bun"
    return
  fi
  if [ "$(uname -s)" = Linux ]; then
    need unzip "Bun's installer needs unzip: install it with your package manager, then run this again."
  fi
  printf '  Installing Bun %s from bun.sh...\n' "$want" >&2
  curl -fsSL https://bun.sh/install | bash -s "bun-v$want" >/dev/null 2>&1 ||
    curl -fsSL https://bun.sh/install | bash -s "bun-v$want" >&2 ||
    fail "Installing Bun failed. See https://bun.sh/docs/installation"
  bun="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
  [ -x "$bun" ] || fail "Bun was installed but $bun is missing."
  printf '%s\n' "$bun"
}

# True when dotted version $1 >= $2.
version_at_least() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    if [ "${x:-0}" -gt "${y:-0}" ]; then return 0; fi
    if [ "${x:-0}" -lt "${y:-0}" ]; then return 1; fi
  done
  return 0
}

# Open the dashboard once the server answers (up to a minute), if there is a browser to open.
open_when_ready() {
  local url="$1" i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url/health" 2>/dev/null; then
      if command -v open >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then open "$url"
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1
      fi
      return 0
    fi
    sleep 1
  done
}

main "$@"
