#!/bin/sh
set -e

node src/scripts/migrate.js
exec node src/server.js
