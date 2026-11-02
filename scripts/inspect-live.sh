#!/bin/zsh
# D10 acceptance (W3-1, 2026-11-02) with an external MCP client (MCP Inspector CLI 2.13.0) against the live base formachines.ai;
# report goes to a local test receiver at 127.0.0.1:8411 (ERRATA_FEEDBACK_URL), never to production.
cd "${0:A:h}/.." && npm run build >/dev/null
I=(npx -y @modelcontextprotocol/inspector@2.13.0 --cli)
run() { local label=$1; shift; echo "### $label"; "${I[@]}" "$@" 2>&1 | python3 -c "
import json,sys
raw=sys.stdin.read()
try:
  d=json.loads(raw); t=d['content'][0]['text']; b=json.loads(t)
  print('isError' , d.get('isError',False)); print(json.dumps(b)[:700])
except Exception as e: print(raw[:700])
"; }
run "list" node dist/bin.js --method tools/list | head -2
"${I[@]}" node dist/bin.js --method tools/list | python3 -c "import json,sys;print([t['name'] for t in json.load(sys.stdin)['tools']])"
run "1 known+checked" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=pypi --tool-arg package=click --tool-arg version=8.5.0
run "1b known, auto_apply false" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=npm --tool-arg package=typeorm --tool-arg version=1.1.2
run "2 no coverage" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=npm --tool-arg package=left-pad --tool-arg version=1.3.0
run "3 future version" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=pypi --tool-arg package=websockets --tool-arg version=18.0
run "3b recheck version" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=pypi --tool-arg package=websockets --tool-arg version=17.4
run "3c intermediate" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=pypi --tool-arg package=scipy --tool-arg version=1.18.0
run "4 exact error" node dist/bin.js --method tools/call --tool-name search_error --tool-arg "text=AttributeError: 'BucketUrl' object has no attribute 'handle'"
run "4b no match" node dist/bin.js --method tools/call --tool-name search_error --tool-arg "text=Segmentation fault (core dumped) in libfoo.so"
run "5 merged via check" node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=pypi --tool-arg package=pyopenssl --tool-arg version=26.4.0
run "5b withdrawn id" node dist/bin.js --method tools/call --tool-name search_error --tool-arg "text=pypi/openai/3.35.1/0001"
run "6 base down" -e ERRATA_BASE_URL=http://127.0.0.1:59999 -e ERRATA_TIMEOUT_MS=2000 node dist/bin.js --method tools/call --tool-name check_package --tool-arg ecosystem=pypi --tool-arg package=click --tool-arg version=8.5.0
run "7 report to local receiver" -e ERRATA_FEEDBACK_URL=http://127.0.0.1:8411/v1/feedback node dist/bin.js --method tools/call --tool-name report --tool-arg id=pypi/click/8.5.0/0001 --tool-arg verdict=confirm "--tool-arg" "note=test from W3-1"
run "7b report merged" -e ERRATA_FEEDBACK_URL=http://127.0.0.1:8411/v1/feedback node dist/bin.js --method tools/call --tool-name report --tool-arg id=pypi/pyopenssl/26.4.0/0005 --tool-arg verdict=dispute
