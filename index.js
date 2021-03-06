let { resolve } = require("path");
let {
  readFileSync: readFile,
  writeFileSync: writeFile,
  readdirSync: readdir,
  statSync: stat
} = require("fs");
let parser = require("@babel/parser");
let traverse = require("@babel/traverse").default;
let generate = require("@babel/generator").default;
let t = require("@babel/types");
let ws = require("ws");

let rootDir = resolve(process.argv[2] || "");
let port = parseInt(process.env.PORT, 10) || 1236;

function iterateSourceFiles(dir, callback) {
  readdir(dir)
    .map(file => resolve(dir, file))
    .forEach(file => {
      if (stat(file).isDirectory()) {
        iterateSourceFiles(file, callback);
      } else {
        callback(file);
      }
    });
}

let jsFiles = [];
iterateSourceFiles(rootDir, file => {
  let source = readFile(file, "utf-8");
  let ast = null;
  try {
    ast = parser.parse(source);
  } catch (err) {
    if (err.name !== "SyntaxError") throw err;
  }

  if (ast) {
    jsFiles.push({ file, ast });
  }
});

function toAST(code) {
  let ast = parser.parse(code);
  let path;
  traverse(ast, {
    Program: function(_path) {
      path = _path.get("body.0");
      _path.stop();
    }
  });
  return path.node;
}

let incineratorFunctionPrefix = "__incinerator__";

let tagging = tag =>
  toAST(`
  (function ${incineratorFunctionPrefix}tagging() {
    var g = typeof window === "undefined" ? window : global;
    g.__incinerator = g.__incinerator || new WebSocket("ws://localhost:${port}");
    if (g.__incinerator.readyState === 1) {
      g.__incinerator.send(${tag});
    } else {
      g.__incinerator.addEventListener('open', function ${incineratorFunctionPrefix}ws() {
        g.__incinerator.send(${tag});
      });
    }
  }())
`);

function removeTaggings(ast) {
  traverse(ast, {
    CallExpression(path) {
      let callee = path.get("callee");
      if (
        t.isFunctionExpression(callee) &&
        callee.node.id &&
        callee.node.id.name.startsWith(incineratorFunctionPrefix)
      ) {
        path.remove();
      }
    }
  });
}

function writeAST(path, ast) {
  writeFile(path, generate(ast).code);
}

let functionId = 0;
let functionPathMap = new Map();

let wss = new ws.Server({ port });

wss.on("connection", ws => {
  ws.on("message", msg => {
    functionPathMap.delete(parseInt(msg, 10));
  });
});

jsFiles.forEach(({ file, ast }) => {
  removeTaggings(ast);

  // add new taggings
  traverse(ast, {
    Function(path) {
      if (
        path.node.id &&
        path.node.id.name.startsWith(incineratorFunctionPrefix)
      ) {
        // skip
      } else {
        let id = functionId++;
        functionPathMap.set(id, path);
        let body = path.get("body");
        if (t.isBlock(body)) {
          body.unshiftContainer("body", tagging(id));
        }
      }
    }
  });

  writeAST(file, ast);
});

let stdin = process.openStdin();
stdin.addListener("data", data => {
  let str = data.toString();
  if (str.includes("!")) {
    incinerate();
  }
});

console.log("Waiting for 'incinerate!'...");

function incinerate() {
  // left paths are unused, let's incinerate them!
  for (let path of functionPathMap.values()) {
    if (t.isFunctionDeclaration(path)) {
      path.remove();
    } else {
      path.node.params = [];
      path.node.body = t.blockStatement([]);
    }
  }

  jsFiles.forEach(({ file, ast }) => {
    removeTaggings(ast);
    writeAST(file, ast);
  });

  wss.close();
  stdin.end();
}
