const fs = require("fs");
const path = "D:\\Mine\\codemem\\.codemem\\db\\index.json";
const data = fs.readFileSync(path, "utf8");
const idx = data.indexOf("}]}999");
console.log("idx", idx, "len", data.length);
console.log("slice", JSON.stringify(data.slice(idx-20, idx+20)));
if (idx === -1) throw new Error("no bad suffix marker");
fs.writeFileSync(path, data.slice(0, idx+3));
console.log("trimmed to", idx+3);
