const fs = require("node:fs");

const logFile = process.argv[2];
let input = Buffer.alloc(0);

const log = (event) => fs.appendFileSync(logFile, `${event}\n`);

const send = (message) => {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const handleMessage = (message) => {
  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      break;
    case "shutdown":
      send({ jsonrpc: "2.0", id: message.id, result: null });
      break;
    case "exit":
      log("stop");
      process.exit(0);
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, result: null });
      }
      break;
  }
};

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const header = input.subarray(0, headerEnd).toString("ascii");
    const lengthMatch = /Content-Length: (\d+)/i.exec(header);
    if (!lengthMatch) {
      process.exit(1);
    }
    const contentLength = Number.parseInt(lengthMatch[1], 10);
    const messageEnd = headerEnd + 4 + contentLength;
    if (input.length < messageEnd) {
      return;
    }
    const body = input.subarray(headerEnd + 4, messageEnd).toString("utf8");
    input = input.subarray(messageEnd);
    handleMessage(JSON.parse(body));
  }
});

log("start");
