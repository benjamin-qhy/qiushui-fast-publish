"""Run the existing behavioral fixtures against Bun. Never connects to the real service."""
import importlib.util
import json
import subprocess
import shutil
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BRIDGE=ROOT/'tests/bun-compat-rpc.ts'
rpc=subprocess.Popen(['bun',str(BRIDGE)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,cwd=ROOT)
def call(op,*args,state=None):
    rpc.stdin.write(json.dumps({'op':op,'args':args,'state':state},default=str)+'\n');rpc.stdin.flush()
    line=rpc.stdout.readline()
    if not line: raise RuntimeError('Bun compatibility bridge exited')
    result=json.loads(line)
    if 'error' in result: raise ValueError(result['error'])
    return result['result']
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tests'/f'{name}.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    target=m.module if hasattr(m,'module') else m.m
    target.preflight=lambda folder,config,action,subset,chinese=False:call('preflight',folder,config,action,subset,chinese)
    target.configured_plans=lambda folder,config,subset,chinese=False:call('plans',folder,config,subset,chinese)
    target.text_skips=lambda folder,config,subset:call('skips',folder,config,subset)
    target.media_file=lambda folder,name:call('image',folder,name)
    target.video_file=lambda folder,name:call('video',folder,name)
    target.claim_task=lambda task:call('claim',task,state=str(target.STATE))
    target.publication.generate=lambda folder,spec,source_root=None:call('generate',folder,spec,source_root)
    if hasattr(m,'AutomaticDeliveryTest'):
        cls=m.AutomaticDeliveryTest
        def setup(self):
            self.temp=tempfile.TemporaryDirectory();self.previous_state=target.STATE
            target.STATE=Path(self.temp.name)/'state';self.folder=Path(self.temp.name)/'content'
            shutil.copytree(m.FIXTURES/'dynamic/image-card-rednote',self.folder)
            self.bun_server=subprocess.Popen(['bun',str(BRIDGE),'serve',str(target.STATE)],stdout=subprocess.PIPE,text=True,cwd=ROOT)
            ready=json.loads(self.bun_server.stdout.readline())
            self.server=type('Server',(),{'server_port':ready['port']})()
            self.extension_id='a'*32
            pairing=self.call('/pairing',{},admin=True)[1]
            self.pair_token=pairing['pairingUrl'].split('#')[1]
            self.executor_token=self.call('/pair-claim',{'token':self.pair_token,'extensionId':self.extension_id})[1]['executorToken']
        def teardown(self):
            self.bun_server.terminate();self.bun_server.wait(timeout=5);self.bun_server.stdout.close();target.STATE=self.previous_state;self.temp.cleanup()
        original_call=cls.call
        def traced(self,path,*args,**kwargs):
            from unittest.mock import Mock
            mock_file=target.STATE/'preflight-override.json'
            if isinstance(target.preflight,Mock): mock_file.write_text(json.dumps(target.preflight.return_value))
            try: return original_call(self,path,*args,**kwargs)
            finally: mock_file.unlink(missing_ok=True)
        cls.call=traced
        cls.setUp=setup;cls.tearDown=teardown
    return m
try:
    modules=[load('test_multipost'),load('test_publication')]
    suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(m) for m in modules)
    result=unittest.TextTestRunner(verbosity=1).run(suite)
finally:
    rpc.stdin.close();rpc.wait(timeout=5);rpc.stdout.close()
raise SystemExit(0 if result.wasSuccessful() else 1)
