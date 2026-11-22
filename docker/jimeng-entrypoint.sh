#!/bin/sh
set -eu

# The application and CLI use the same private user session. Only the dedicated
# credential volume persists. The bus socket stays inside this container.
original_umask=$(umask)
umask 077
storage=/var/lib/drama-plus/jimeng
export XDG_DATA_HOME="$storage/data"
export XDG_CONFIG_HOME="$storage/config"
export DREAMINA_CANVAS_STATE_DIR="$storage/state"
XDG_RUNTIME_DIR=$(mktemp -d /tmp/drama-plus-jimeng.XXXXXX)
export XDG_RUNTIME_DIR
mkdir -p "$storage" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$DREAMINA_CANVAS_STATE_DIR"
chmod 0700 "$storage" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$DREAMINA_CANVAS_STATE_DIR"

# The official CLI stores OAuth sessions under ~/.local/share.
oauth_store="$storage/home-share"
home_share="${HOME:-/root}/.local/share"
mkdir -p "$oauth_store" "$(dirname "$home_share")"
chmod 0700 "$oauth_store"
if [ -d "$home_share" ] && [ ! -L "$home_share" ]; then
  rmdir "$home_share" || { echo 'Move the Dreamina OAuth store to its persistent volume before starting the app' >&2; exit 1; }
fi
if [ ! -L "$home_share" ]; then
  ln -s "$oauth_store" "$home_share"
fi
if [ "$(readlink "$home_share")" != "$oauth_store" ]; then
  echo 'Dreamina OAuth store is linked to an unexpected location' >&2
  exit 1
fi

unlock_key="$storage/keyring-password"
if [ ! -f "$unlock_key" ]; then
  if [ -f "$XDG_DATA_HOME/keyrings/login.keyring" ]; then
    echo 'Dreamina credential keyring exists but its unlock key is missing' >&2
    exit 1
  fi
  node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(48).toString("hex"), { mode: 0o600, flag: "wx" })' "$unlock_key"
fi
chmod 0600 "$unlock_key"

DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export DBUS_SESSION_BUS_ADDRESS
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS" --nopidfile
gnome-keyring-daemon --daemonize --unlock --components=secrets < "$unlock_key" >/dev/null

keyring_status=$(dbus-send --session --print-reply --reply-timeout=5000 --dest=org.freedesktop.secrets \
  /org/freedesktop/secrets/collection/login org.freedesktop.DBus.Properties.Get \
  string:org.freedesktop.Secret.Collection string:Locked)
case "$keyring_status" in
  *'boolean false'*) ;;
  *) echo 'Dreamina credential keyring could not be unlocked' >&2; exit 1 ;;
esac

umask "$original_umask"
exec "$@"
