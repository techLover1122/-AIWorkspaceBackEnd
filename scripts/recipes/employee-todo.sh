#!/usr/bin/env bash
# employee-todo.sh — tmux recipe replayed at boot by
# /usr/local/bin/ai-ide-restart-services.sh (the ai-ide-services.service
# unit) for every *.sh in ~/.ai-ide/services/.
#
# Starts the employee-todo Next.js dev server on port 3456 which serves
# the `employees-<USER>.<DOMAIN>` subdomain. That subdomain hosts the
# /edit page that mounts the ONLYOFFICE editor — without this running,
# both Document.docx and Employees.xlsx tabs show "Bad Gateway".
#
# Install with:
#   install -m 755 employee-todo.sh ~/.ai-ide/services/employee-todo.sh
set -euo pipefail
cd /home/ubuntu/employee-todo
exec npm run dev
