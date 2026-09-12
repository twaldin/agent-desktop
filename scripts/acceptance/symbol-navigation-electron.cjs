const { app } = require("electron");
const { join } = require("node:path");
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.setAppPath(join(process.argv[2], "apps/desktop"));
require(join(process.argv[2], "apps/desktop/dist/main.cjs"));
