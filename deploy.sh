#!/usr/bin/env bash
# Сборка и деплой cup-holder-3d на сервер (первичная настройка — box-3d/deploy/server-setup.sh).
set -euo pipefail
cd "$(dirname "$0")"

SERVER="${DEPLOY_SERVER:-perseus@89.169.174.88}"
APP="cup-holder-3d"

npm run build
rsync -az --delete dist/ "$SERVER:/srv/www/$APP/"

echo "Готово: https://3d.perseus.fyi/$APP/"
