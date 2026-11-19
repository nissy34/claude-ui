#!/bin/bash
# End-to-end test of the handoff MCP's file tools (list/read/write files, download and upload
# links, folders as zip, path confinement). Starts its own server on a temp HOME.
#   bash scripts/test-mcp-files.sh        (needs curl, zip, unzip, python3)
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
D=$(mktemp -d)
H=$D/home
PORT=${PORT:-8899}
trap 'kill $SERVER 2>/dev/null; rm -rf "$D"' EXIT
mkdir -p "$H/projects/sandbox/density-runs/2026-11-19_regular_726/sub" "$H/outside"
echo '<h1>run 2</h1>' > "$H/projects/sandbox/density-runs/2026-11-19_regular_726/report.html"
head -c 300000 /dev/urandom > "$H/projects/sandbox/density-runs/2026-11-19_regular_726/blob.bin"
echo hi > "$H/projects/sandbox/density-runs/2026-11-19_regular_726/sub/x.md"
echo secret > "$H/outside/secret.txt"
ln -s ../../outside "$H/projects/sandbox/escape"
python3 - "$H/projects/sandbox/pic.png" <<'PY'
import zlib, struct, sys
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b''))
PY
(cd "$REPO" && HOME=$H CW_PASSWORD=x CW_PORT=$PORT CW_PROJECTS_ROOT=$H/projects CW_MCP_TOKEN=tok CW_BROWSER=0 CW_CLAUDE_BIN=/bin/false exec node server/index.js > "$D/server.log" 2>&1) &
SERVER=$!
for _ in $(seq 50); do curl -s "localhost:$PORT/" >/dev/null && break; sleep 0.2; done
OUT=$D/out; mkdir -p "$OUT"
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1: $2"; fail=$((fail+1)); }
call() { # name json-args -> prints result text (or "ERR: ..." on isError)
  curl -s localhost:$PORT/mcp -H 'Authorization: Bearer tok' -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" |
    python3 -c "import json,sys; r=json.load(sys.stdin)['result']; c=r['content']; print(('ERR: ' if r.get('isError') else '')+(c[0]['text'] if len(c)==1 else json.dumps(c)))"
}
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# A chat in the sandbox project, waiting (no CLI started).
SID=$(call handoff '{"task":"density runs","project":"sandbox","start_now":false}' | j 'd["session"]["id"]')
[ -n "$SID" ] && ok "handoff created $SID" || bad handoff "no id"

R=$(call list_files "{\"id\":\"$SID\",\"path\":\"density-runs\",\"recursive\":true}")
echo "$R" | grep -q '"density-runs/2026-11-19_regular_726/sub/x.md"' && ok "list_files recursive" || bad list_files "$R"

R=$(call list_files "{\"id\":\"$SID\",\"path\":\"$H/projects/sandbox/density-runs\"}")
echo "$R" | grep -q '2026-11-19_regular_726' && ok "list_files absolute path inside" || bad "list abs" "$R"

R=$(call list_files "{\"id\":\"$SID\",\"path\":\"$H/outside\"}")
[[ $R == ERR:*outside* ]] && ok "absolute path outside refused" || bad "outside" "$R"
R=$(call read_file "{\"id\":\"$SID\",\"path\":\"../outside/secret.txt\"}")
[[ $R == ERR:* ]] && ok "../ escape refused" || bad "dotdot" "$R"
R=$(call read_file "{\"id\":\"$SID\",\"path\":\"escape/secret.txt\"}")
[[ $R == ERR:* ]] && ok "symlink escape refused" || bad "symlink" "$R"
R=$(call list_files "{\"id\":\"$SID\"}")
echo "$R" | grep -q '"escape"' && bad "symlink listed" "$R" || ok "symlink out of root not listed"

R=$(call read_file "{\"id\":\"$SID\",\"path\":\"density-runs/2026-11-19_regular_726/report.html\"}")
echo "$R" | grep -q 'run 2' && ok "read_file text" || bad read "$R"
R=$(call read_file "{\"id\":\"$SID\",\"path\":\"density-runs/2026-11-19_regular_726/report.html\",\"offset\":4,\"max_bytes\":3}")
[ "$(echo "$R" | j 'd["content"]')" = "run" ] && ok "read_file offset" || bad offset "$R"
R=$(call read_file "{\"id\":\"$SID\",\"path\":\"density-runs/2026-11-19_regular_726/blob.bin\"}")
echo "$R" | grep -q '"binary": true' && ok "read_file binary -> points to download_link" || bad bin "$R"
R=$(call read_file "{\"id\":\"$SID\",\"path\":\"pic.png\"}")
echo "$R" | grep -q '"type": "image"' && ok "read_file image content" || bad image "${R:0:200}"

# Download one binary file
R=$(call download_link "{\"id\":\"$SID\",\"path\":\"density-runs/2026-11-19_regular_726/blob.bin\"}")
U=$(echo "$R" | j 'd["url"]')
curl -fsSL -o "$OUT/blob.bin" "$U" && cmp -s "$OUT/blob.bin" "$H/projects/sandbox/density-runs/2026-11-19_regular_726/blob.bin" && ok "download file byte-identical" || bad download "$R"

# Download a folder as zip and unzip it
R=$(call download_link "{\"project\":\"sandbox\",\"path\":\"density-runs\"}")
U=$(echo "$R" | j 'd["url"]')
curl -fsSL -o "$OUT/runs.zip" "$U" && (cd "$OUT" && unzip -tq runs.zip >/dev/null && unzip -q runs.zip -d unz) && diff -r "$OUT/unz/density-runs" "$H/projects/sandbox/density-runs" && ok "folder zip downloads, tests clean, matches (via project)" || bad zip "$R"
python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()),'entries')" "$OUT/runs.zip" && ok "python zipfile reads it"

R=$(call download_link "{\"id\":\"$SID\",\"path\":\"../outside\"}")
[[ $R == ERR:* ]] && ok "download outside refused" || bad dlout "$R"
code=$(curl -s -o /dev/null -w '%{http_code}' localhost:$PORT/mcp/files/nope/x)
[ "$code" = 404 ] && ok "unknown link 404" || bad "unknown link" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -T "$OUT/blob.bin" "$U")
[ "$code" = 405 ] && ok "PUT on download link refused" || bad "put on get" "$code"

# write_file
R=$(call write_file "{\"id\":\"$SID\",\"path\":\"inbox/notes/a.txt\",\"content\":\"hello\"}")
[ "$(cat "$H/projects/sandbox/inbox/notes/a.txt")" = hello ] && ok "write_file creates folders" || bad write "$R"
R=$(call write_file "{\"id\":\"$SID\",\"path\":\"inbox/notes/a.txt\",\"content\":\"x\"}")
[[ $R == ERR:*exists* ]] && ok "write_file refuses overwrite" || bad "no overwrite" "$R"
B64=$(printf '\x00\x01\xff' | base64)
R=$(call write_file "{\"id\":\"$SID\",\"path\":\"inbox/notes/a.txt\",\"content\":\"$B64\",\"encoding\":\"base64\",\"overwrite\":true}")
[ "$(od -An -tx1 "$H/projects/sandbox/inbox/notes/a.txt" | tr -d " \n")" = 0001ff ] && ok "write_file base64 overwrite" || bad b64 "$R"
R=$(call write_file "{\"id\":\"$SID\",\"path\":\"escape/pwn.txt\",\"content\":\"x\"}")
[[ $R == ERR:* ]] && [ ! -e "$H/outside/pwn.txt" ] && ok "write through symlink refused" || bad "write symlink" "$R"
R=$(call write_file "{\"id\":\"$SID\",\"path\":\"$H/outside/pwn.txt\",\"content\":\"x\"}")
[[ $R == ERR:* ]] && ok "write absolute outside refused" || bad "write abs" "$R"

# upload_link: single, subfolder, multiple, zip
R=$(call upload_link "{\"id\":\"$SID\",\"path\":\"uploads\"}")
U=$(echo "$R" | j 'd["url"]')
head -c 2000000 /dev/urandom > "$OUT/big.bin"; echo a > "$OUT/a.txt"; echo b > "$OUT/b.txt"
curl -fsS -T "$OUT/big.bin" "$U" >/dev/null && cmp -s "$OUT/big.bin" "$H/projects/sandbox/uploads/big.bin" && ok "upload single binary (curl -T keeps name)" || bad up1 "$R"
curl -fsS -T "$OUT/a.txt" "${U}deep/er/a.txt" >/dev/null && [ -f "$H/projects/sandbox/uploads/deep/er/a.txt" ] && ok "upload into subfolder" || bad up2 ""
curl -fsS -T "{$OUT/a.txt,$OUT/b.txt}" "$U" >/dev/null && [ -f "$H/projects/sandbox/uploads/b.txt" ] && ok "upload several" || bad up3 ""
code=$(curl -s -o /dev/null -w '%{http_code}' -T "$OUT/a.txt" "$U")
[ "$code" = 409 ] && ok "upload refuses existing file (409)" || bad up4 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -T "$OUT/a.txt" "${U}..%2F..%2F..%2Foutside%2Fevil.txt")
[ "$code" != 200 ] && [ ! -e "$H/outside/evil.txt" ] && ok "upload ../ name refused ($code)" || bad up5 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is -T "$OUT/a.txt" "${U}../../escape/evil.txt")
[ ! -e "$H/outside/evil.txt" ] && ok "upload path-as-is ../ stays in ($code)" || bad up6 "$code"
mkdir -p "$OUT/folder/inner/empty" && echo deep > "$OUT/folder/inner/d.txt" && cp "$OUT/big.bin" "$OUT/folder/"
(cd "$OUT" && zip -qr - folder) | curl -fsS -T - "${U}?extract=zip" > "$OUT/zipres.json" && diff -r "$OUT/folder" "$H/projects/sandbox/uploads/folder" && ok "upload streamed zip, extracted identical (incl. empty dir)" || bad upzip "$(cat "$OUT/zipres.json")"
code=$(cd "$OUT" && zip -qr - folder | curl -s -o /dev/null -w '%{http_code}' -T - "${U}?extract=zip")
[ "$code" = 409 ] && ok "zip refuses existing files" || bad upzip2 "$code"
python3 - "$OUT/evil.zip" <<'EOF'
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../../../outside/zipevil.txt','x'); z.close()
EOF
code=$(curl -s -o /dev/null -w '%{http_code}' -T "$OUT/evil.zip" "${U}?extract=zip")
[ "$code" = 400 ] && [ ! -e "$H/outside/zipevil.txt" ] && ok "zip-slip refused" || bad zipslip "$code"
python3 - "$OUT/link.zip" <<'EOF'
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo('lnk'); i.external_attr=(0o120777<<16); z.writestr(i,'/etc/passwd'); z.writestr('ok.txt','fine'); z.close()
EOF
curl -fsS -T "$OUT/link.zip" "${U}?extract=zip" >/dev/null && [ ! -e "$H/projects/sandbox/uploads/lnk" ] && [ -f "$H/projects/sandbox/uploads/ok.txt" ] && ok "zip symlink entries skipped" || bad ziplink ""
ls -a "$H/projects/sandbox/uploads" | grep -q '\.part$' && bad "leftover .part" "" || ok "no leftover temp files"

R=$(call upload_link "{\"id\":\"$SID\",\"path\":\"uploads\",\"overwrite\":true}")
U2=$(echo "$R" | j 'd["url"]')
curl -fsS -T "$OUT/a.txt" "$U2" >/dev/null && ok "overwrite link replaces" || bad ow ""

R=$(cat "$H"/.claude-web/chats/$SID.jsonl)
echo "$R" | grep -q 'Claude Desktop added' && ok "chat shows upload notices" || bad notice "${R:0:300}"

code=$(curl -s -o /dev/null -w '%{http_code}' localhost:$PORT/api/sessions)
echo "(api without cookie -> $code)"
echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
