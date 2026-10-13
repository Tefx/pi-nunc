# purpose: Serve unchanged official read-only Travel ToolExecutor to isolated Pi agents; load304MB CSV once instead of per tool subprocess.
# usage: runtime/venv/bin/python helpers/travel_tools.py <absolute-task-root>
# effects: Loopback ephemeral-port HTTP, task-local readiness/metadata log; no outside API, credentials, model, memory server, gold or future-query access.
# requires: pandas/requests in task venv, pinned official source and complete CSVs. Uses official run_for_evaluation for DistanceMatrix.
import contextlib,json,os,signal,sys,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
root=Path(sys.argv[1]).resolve();sys.path.insert(0,str(root/'runtime/MemoryArena/env/env_systems'))
from database import validate_live_database
flight_bytes=validate_live_database(root)
from travel_planner_env.tool_executor import ToolExecutor
with contextlib.redirect_stdout(sys.stderr):executor=ToolExecutor()
allowed={x['function']['name'] for x in json.loads((root/'runtime/tools.json').read_text())}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send_json(self,code,data):
  body=json.dumps(data,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if self.path=='/health':self.send_json(200,{'ready':True,'pid':os.getpid(),'tools':sorted(allowed),'flightCsvBytes':flight_bytes})
  else:self.send_json(404,{'error':'unknown path'})
 def do_POST(self):
  if self.path!='/tool':return self.send_json(404,{'error':'unknown path'})
  n=int(self.headers.get('Content-Length','0'))
  if not 0<n<=65536:return self.send_json(400,{'error':'bad request length'})
  req=json.loads(self.rfile.read(n));name=req.get('name');args=req.get('args');begin=time.monotonic()
  if name not in allowed or not isinstance(args,dict):return self.send_json(400,{'error':'unknown tool or arguments'})
  with contextlib.redirect_stdout(sys.stderr):result=executor.execute(name,args)
  with (root/'logs/tool-service.jsonl').open('a') as f:f.write(json.dumps({'at':time.time(),'name':name,'args':args,'chars':len(result),'elapsedMs':(time.monotonic()-begin)*1000,'error':result.startswith('Error')},ensure_ascii=False)+'\n')
  self.send_json(200,{'name':name,'result':result})
server=HTTPServer(('127.0.0.1',0),Handler)
(root/'runtime/tool-service.json').write_text(json.dumps({'url':f'http://127.0.0.1:{server.server_port}','pid':os.getpid(),'readonly':True})+'\n')
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
try:server.serve_forever()
finally:server.server_close()
