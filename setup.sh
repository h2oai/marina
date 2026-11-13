#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Marina setup: one command from nothing to a running Marina.
#
#   curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash
#
# Everything goes in one folder, ~/.marina (MARINA_HOME): the code in ~/.marina/app, Bun in
# ~/.marina/bun when you have none, the `marina` command in ~/.marina/bin, and your worlds and
# settings beside them. It installs packages, builds the dashboard, puts `marina` on your PATH,
# asks for one thing (a model API key, Enter to skip), then starts Marina and opens it in your
# browser. Run it again to update; your settings and world are kept. An older install in
# ~/marina is moved in.
#
# Options (after `bash -s --` when piped):
#   --dir <path>   put the code here instead of ~/.marina/app (or set MARINA_DIR)
#   --yes          ask nothing and do not start Marina: for AI agents and scripts
#   --no-start     set up, but do not start Marina at the end
#   --no-modify-path  leave your shell's startup file alone
#   --uninstall    remove Marina and everything it made (asks first; `--yes` to not ask,
#                  `--keep-data` to keep your worlds)
#   --help         this text
#
# It never uses sudo. Outside ~/.marina it changes only one PATH line in your shell's startup
# file (marked "# Added by Marina setup"), and only when `marina` would not be found otherwise.

set -euo pipefail

# Everything runs from main(), called on the last line, so a download cut short runs nothing.
main() {
  local home="${MARINA_HOME:-$HOME/.marina}"
  local dir="${MARINA_DIR:-$home/app}" dir_set=0
  [ -n "${MARINA_DIR:-}" ] && dir_set=1
  local assume_yes=0 start=1 modify_path=1
  local repo="${MARINA_SETUP_REPO:-https://github.com/h2oai/marina.git}"
  local ref="${MARINA_SETUP_REF:-main}"

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="${2:?--dir needs a folder}"; dir_set=1; shift 2 ;;
      --dir=*) dir="${1#--dir=}"; dir_set=1; shift ;;
      --yes|-y) assume_yes=1; start=0; shift ;;
      --no-start) start=0; shift ;;
      --no-modify-path) modify_path=0; shift ;;
      --uninstall) shift; uninstall "$home" "$@"; return ;;
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

  # An install from before the one home (~/marina): update it where it is, then move it in.
  local legacy=""
  if [ "$dir_set" -eq 0 ] && [ ! -e "$dir" ] && [ -f "$HOME/marina/.bun-version" ]; then
    legacy="$HOME/marina"
  fi

  say "Setting up Marina in $home"
  mkdir -p "$home"
  chmod 700 "$home" 2>/dev/null || true

  step "1/5" "Downloading Marina"
  fetch_marina "$repo" "$ref" "${legacy:-$dir}"

  step "2/5" "Checking Bun (the runtime Marina uses)"
  local bun
  bun="$(ensure_bun "$(tr -d '[:space:]' <"${legacy:-$dir}/.bun-version")" "$home")"

  if [ -n "$legacy" ]; then
    if [ -f "$legacy/scripts/home.ts" ]; then
      say "  Moving your Marina from $legacy into $home"
      dir="$("$bun" --no-env-file "$legacy/scripts/home.ts" migrate "$legacy")" ||
        fail "Could not move $legacy into $home (see above)."
    else
      dir="$legacy"
    fi
  fi
  cd "$dir"

  step "3/5" "Installing packages (a minute or two)"
  "$bun" install --no-env-file --no-progress >/dev/null 2>&1 || "$bun" install --no-env-file

  step "4/5" "Building the dashboard"
  "$bun" run --no-env-file dashboard:build >/dev/null 2>&1 || "$bun" run --no-env-file dashboard:build

  step "5/5" "Putting marina on your PATH"
  write_command "$home" "$bun" "$dir"
  remove_old_links "$home"
  if [ "$modify_path" -eq 1 ]; then
    add_to_path "$home/bin"
  else
    say "  marina is in $home/bin; add it to your PATH to use it."
  fi

  # Settings and the world live in the home, never in the code folder.
  cd "$home"
  if [ "$assume_yes" -eq 1 ]; then
    "$bun" --no-env-file "$dir/scripts/marina.ts" init --yes | sed 's/^/  /'
  else
    "$bun" --no-env-file "$dir/scripts/marina.ts" init </dev/tty
  fi

  local url="http://localhost:${WS_PORT:-3300}"
  if [ "$start" -eq 1 ]; then
    say ""
    say "Starting Marina. It opens in your browser at $url"
    say "Keep this window open while you use it; close it (or press Ctrl+C) to stop."
    say "To start it again later, open a new terminal and type: marina start"
    open_when_ready "$url" &
    exec "$bun" --no-env-file "$dir/scripts/marina.ts" start </dev/tty
  fi

  say ""
  say "Marina is installed in $home."
  say "Start it: open a new terminal window and type  marina start"
  say "Then open $url. With no model key yet, add one in the dashboard: Admin, then Keys."
  say "To remove it later: marina uninstall"
}

usage() {
  cat <<'USAGE'
Marina setup: puts everything in ~/.marina (the code, Bun if you have none, your worlds and
settings), builds it, puts `marina` on your PATH, asks for a model API key (Enter to skip), then
starts Marina and opens it in your browser.

  curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash
  curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash -s -- --yes
  curl -fsSL https://raw.githubusercontent.com/h2oai/marina/main/setup.sh | bash -s -- --uninstall

  --dir <path>   put the code here instead of ~/.marina/app (or set MARINA_DIR)
  --yes          ask nothing and do not start Marina: for AI agents and scripts
  --no-start     set up, but do not start Marina at the end
  --no-modify-path  do not add marina's folder to your shell's startup file
  --uninstall    remove Marina and everything it made (also: marina uninstall)
  --help         this text
USAGE
}
say() { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
fail() { printf 'Marina setup stopped: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"; }

# The `marina` command: a small script in the home's bin/ that runs the code with its Bun, so
# one folder on PATH is enough (Bun itself need not be on PATH).
write_command() {
  local home="$1" bun="$2" dir="$3"
  mkdir -p "$home/bin"
  cat >"$home/bin/marina" <<EOF
#!/bin/sh
# Marina's command, written by setup.sh. \`marina uninstall\` removes it with the rest of Marina.
exec "$bun" --no-env-file "$dir/scripts/marina.ts" "\$@"
EOF
  chmod 755 "$home/bin/marina"
}

# Links older setups made (~/.bun/bin/marina, ~/.local/bin/marina) to code that has since moved
# (into the home, or away): remove them so the new command is the one found. A link to some
# other Marina checkout that still exists (a developer's) is left alone.
remove_old_links() {
  local home="$1" d link target
  for d in "${BUN_INSTALL:-$HOME/.bun}/bin" "$HOME/.local/bin"; do
    link="$d/marina"
    [ -L "$link" ] || continue
    target="$(readlink "$link")"
    case "$target" in */scripts/marina.ts) ;; *) continue ;; esac
    if [ ! -e "$target" ] || case "$target" in "$home"/*|"$HOME/marina"/*) true ;; *) false ;; esac; then
      rm -f "$link"
    fi
  done
}

# Remove Marina: the code's own uninstaller does the work (it shows everything and asks once).
uninstall() {
  local home="$1" app="" bun="" d b
  shift
  for d in "${MARINA_DIR:-}" "$home/app" "$HOME/marina"; do
    if [ -n "$d" ] && [ -f "$d/scripts/home.ts" ]; then app="$d"; break; fi
  done
  for b in "$home/bun/bin/bun" "$(command -v bun 2>/dev/null || true)" "${BUN_INSTALL:-$HOME/.bun}/bin/bun"; do
    if [ -n "$b" ] && [ -x "$b" ]; then bun="$b"; break; fi
  done
  if [ -z "$app" ] || [ -z "$bun" ]; then
    say "No Marina to run the uninstaller from. To remove it by hand: delete $home, the line after"
    say "\"# Added by Marina setup\" in your shell's startup file, and ~/marina if an older setup made it."
    return 1
  fi
  if { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null; then
    exec "$bun" --no-env-file "$app/scripts/home.ts" uninstall "$@" </dev/tty
  fi
  exec "$bun" --no-env-file "$app/scripts/home.ts" uninstall "$@"
}

# Make `marina` found in new terminals: add each folder that is not on PATH to the shell's
# startup file once, unless the file already names it. `marina uninstall` removes the line.
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
    if have_git && git -C "$dir" -c advice.diverging=false pull --ff-only --quiet origin "$ref" \
      >/dev/null 2>&1; then
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

# Print the path of a Bun at least version $1: one already on this machine, else Marina's own,
# installed into $2/bun with Bun's official installer (told SHELL=sh, so it edits no shell file).
ensure_bun() {
  local want="$1" home="$2" bun="" candidate
  for candidate in "$home/bun/bin/bun" "$(command -v bun 2>/dev/null || true)" "${BUN_INSTALL:-$HOME/.bun}/bin/bun"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && version_at_least "$("$candidate" --version)" "$want"; then
      printf '  Bun %s found.\n' "$("$candidate" --version)" >&2
      printf '%s\n' "$candidate"
      return
    fi
  done
  if [ "$(uname -s)" = Linux ]; then
    need unzip "Bun's installer needs unzip: install it with your package manager, then run this again."
  fi
  printf '  Installing Bun %s into %s/bun from bun.sh...\n' "$want" "$home" >&2
  local install=(env BUN_INSTALL="$home/bun" SHELL=/bin/sh bash -s "bun-v$want")
  curl -fsSL https://bun.sh/install | "${install[@]}" >/dev/null 2>&1 ||
    curl -fsSL https://bun.sh/install | "${install[@]}" >&2 ||
    fail "Installing Bun failed. See https://bun.sh/docs/installation"
  bun="$home/bun/bin/bun"
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
