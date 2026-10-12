import importlib.util
import json
import shutil
import tempfile
import time
import unittest
import threading
from unittest.mock import patch
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures'
SCRIPT = ROOT / 'skills/qiushui-fast-publish/scripts/multipost.py'

spec = importlib.util.spec_from_file_location('multipost', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name) / 'content'
        shutil.copytree(FIXTURES / 'dynamic/image-card-rednote', self.folder)
        self.metadata = module.read_metadata(self.folder / 'content.yaml')

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        (self.folder / 'content.yaml').unlink(missing_ok=True)
        (self.folder / 'content.json').write_text(json.dumps(self.metadata))

    def plan(self, action='prepare', subset='DYNAMIC_REDNOTE'):
        return module.preflight(self.folder, module.DEFAULT_CONFIG, action, subset)

    def test_default_plan_and_explicit_override(self):
        self.metadata['overrides'] = {'DYNAMIC_REDNOTE': {'title': '覆盖标题'}}
        self.write()
        plan = self.plan()
        self.assertEqual(plan['action'], 'prepare')
        self.assertEqual(plan['data']['title'], '覆盖标题')
        self.assertEqual(len(plan['data']['images'][0]['sha256']), 64)

    def test_missing_image_stops_before_bridge(self):
        (self.folder / 'test-card.png').unlink()
        with self.assertRaisesRegex(ValueError, '文件不存在'):
            self.plan()

    def test_symlink_outside_content_is_rejected(self):
        external = Path(self.temp.name) / 'outside.png'
        (self.folder / 'test-card.png').rename(external)
        (self.folder / 'test-card.png').symlink_to(external)
        with self.assertRaisesRegex(ValueError, '越出内容目录'):
            self.plan()

    def test_unverified_publish_is_not_downgraded(self):
        for action in ['publish', 'save_draft']:
            with self.assertRaisesRegex(ValueError, '不降级'):
                self.plan(action)

    def test_x_weighted_limit_rejects_chinese_text_that_exceeds_composer_limit(self):
        self.metadata.pop('bodyFile', None)
        self.metadata['title'] = '标题'
        self.metadata['content'] = '中文' * 75
        self.metadata['tags'] = []
        self.write()
        with self.assertRaisesRegex(ValueError, '加权字符限制'):
            self.plan(subset='DYNAMIC_X')

    def test_unconfigured_platform_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '子集'):
            self.plan(subset='DYNAMIC_WEIBO')

    def test_type_override_is_rejected(self):
        self.metadata['overrides'] = {'DYNAMIC_REDNOTE': {'type': 'VIDEO'}}
        self.write()
        with self.assertRaisesRegex(ValueError, '不能改变内容类型'):
            self.plan()

    def test_invalid_image_bytes_are_rejected(self):
        (self.folder / 'test-card.png').write_text('not a png')
        with self.assertRaisesRegex(ValueError, '后缀不一致'):
            self.plan()

    def test_unimplemented_fields_are_not_silently_ignored(self):
        self.metadata['original'] = True
        self.write()
        with self.assertRaisesRegex(ValueError, '尚未适配'):
            self.plan()

    def test_interrupted_executor_becomes_unknown_not_complete(self):
        path = Path(self.temp.name) / 'task.json'
        module.atomic(path, {'receipt': {'status': 'running', 'tabId': 123}, 'updatedAt': time.time() - 121})
        result = module.load_task(path)
        self.assertEqual(result['receipt']['status'], 'result_unconfirmed')
        self.assertEqual(result['receipt']['tabId'], 123)

    def test_weixin_article_requires_explicit_draft_and_cover(self):
        article = Path(self.temp.name) / 'article'
        shutil.copytree(FIXTURES / 'article/weixin-draft', article)
        config = Path(self.temp.name) / 'article-platforms.json'
        config.write_text(json.dumps({'ARTICLE': ['ARTICLE_WEIXIN']}))
        with self.assertRaisesRegex(ValueError, 'save_draft'):
            module.preflight(article, config, 'prepare', None)
        plan = module.preflight(article, config, 'save_draft', None)
        self.assertEqual(plan['platform'], 'ARTICLE_WEIXIN')
        self.assertEqual(plan['data']['cover']['type'], 'image/png')
        (article / 'cover.png').unlink()
        with self.assertRaisesRegex(ValueError, '文件不存在'):
            module.preflight(article, config, 'save_draft', None)

    def test_weixin_video_preflight_checks_file_and_action(self):
        folder = Path(self.temp.name) / 'video'
        shutil.copytree(FIXTURES / 'video/weixinchannel-prepare', folder)
        config = Path(self.temp.name) / 'video-platforms.json'
        config.write_text(json.dumps({'VIDEO': ['VIDEO_WEIXINCHANNEL']}))
        plan = module.preflight(folder, config, 'prepare', None)
        self.assertEqual(plan['platform'], 'VIDEO_WEIXINCHANNEL')
        self.assertEqual(plan['data']['video']['type'], 'video/mp4')
        with self.assertRaisesRegex(ValueError, 'prepare'):
            module.preflight(folder, config, 'publish', None)
        (folder / 'test.mp4').write_bytes(b'not a video')
        with self.assertRaisesRegex(ValueError, '有效 MP4'):
            module.preflight(folder, config, 'prepare', None)

    def test_configured_dynamic_plans_use_platform_actions_in_order(self):
        plans = module.configured_plans(self.folder, module.DEFAULT_CONFIG, None)
        self.assertEqual([(plan['platform'], plan['action']) for plan in plans], [
            ('DYNAMIC_REDNOTE', 'prepare'), ('DYNAMIC_WEIXIN', 'save_draft'),
            ('DYNAMIC_WEIXINCHANNEL', 'publish'), ('DYNAMIC_DOUYIN', 'prepare'),
            ('DYNAMIC_TOUTIAO', 'prepare'), ('DYNAMIC_OKJIKE', 'prepare'),
            ('DYNAMIC_ZSXQ', 'prepare'), ('DYNAMIC_MAIMAI', 'prepare'),
            ('DYNAMIC_X', 'prepare')
        ])

    def test_video_channel_publish_uses_original_prepared_task(self):
        plan = self.plan(action='publish', subset='DYNAMIC_WEIXINCHANNEL')
        prepared = {'taskId': 'prepared-id', 'receipt': {'status': 'filled'}}
        published = {'taskId': 'published-id', 'receipt': {'status': 'published'}}
        with patch.object(module, 'request', side_effect=[prepared, published]) as request, \
                patch.object(module, 'wait_for_terminal', side_effect=[prepared, published]):
            result = module.execute_plan(self.folder, module.DEFAULT_CONFIG, plan, 1)
        self.assertEqual(result, published)
        self.assertEqual(request.call_args_list[0].args[1]['action'], 'prepare')
        self.assertEqual(request.call_args_list[1].args, ('/publish', {'taskId': 'prepared-id'}))

    def test_video_channel_does_not_publish_failed_preparation(self):
        plan = self.plan(action='publish', subset='DYNAMIC_WEIXINCHANNEL')
        prepared = {'taskId': 'prepared-id', 'receipt': {'status': 'needs_attention'}}
        with patch.object(module, 'request', return_value=prepared) as request, \
                patch.object(module, 'wait_for_terminal', return_value=prepared):
            result = module.execute_plan(self.folder, module.DEFAULT_CONFIG, plan, 1)
        self.assertEqual(result, prepared)
        self.assertEqual(request.call_count, 1)

    def test_text_preflight_uses_body_and_appends_tags_without_title(self):
        self.metadata['title'] = '标题不可发送'
        self.metadata['tags'] = ['纯文字测试']
        self.metadata['images'] = []
        self.write()
        plan = self.plan(subset='DYNAMIC_X')
        self.assertTrue(plan['data']['textOnly'])
        self.assertEqual(plan['data']['title'], '')
        self.assertEqual(plan['data']['content'], (self.folder / 'body.md').read_text().rstrip() + '\n#纯文字测试')
        self.assertEqual(plan['data']['images'], [])
        with self.assertRaisesRegex(ValueError, '无图内容'):
            self.plan(subset='DYNAMIC_REDNOTE')
        plans = module.configured_plans(self.folder, module.DEFAULT_CONFIG, None)
        self.assertEqual([plan['platform'] for plan in plans], [
            'DYNAMIC_TOUTIAO', 'DYNAMIC_OKJIKE', 'DYNAMIC_ZSXQ', 'DYNAMIC_MAIMAI', 'DYNAMIC_X'
        ])
        self.assertEqual(len(module.text_skips(self.folder, module.DEFAULT_CONFIG, None)), 4)
        empty_config = Path(self.temp.name) / 'empty-text.json'
        empty_config.write_text(json.dumps({'DYNAMIC': ['DYNAMIC_X'], 'textVerified': [], 'actions': {'DYNAMIC_X': 'prepare'}}))
        with self.assertRaisesRegex(ValueError, '没有经本机插件真实验证'):
            module.configured_plans(self.folder, empty_config, None)

    def test_zsxq_requires_explicit_target_sphere(self):
        plan = self.plan(subset='DYNAMIC_ZSXQ')
        self.assertEqual(plan['data']['targetSphere'], 'AI咖啡馆')
        config = Path(self.temp.name) / 'zsxq.json'
        config.write_text(json.dumps({'DYNAMIC': ['DYNAMIC_ZSXQ']}))
        with self.assertRaisesRegex(ValueError, 'targetSphere'):
            module.preflight(self.folder, config, 'prepare', None)

    def test_x_rejects_content_over_280_characters(self):
        self.metadata['content'] = 'x' * 280
        self.metadata.pop('bodyFile', None)
        self.write()
        with self.assertRaisesRegex(ValueError, '280'):
            self.plan(subset='DYNAMIC_X')

    def test_weixin_dynamic_draft_preserves_all_content(self):
        config = Path(self.temp.name) / 'platforms.json'
        config.write_text(json.dumps({'DYNAMIC': ['DYNAMIC_WEIXIN']}))
        self.metadata['title'] = '公众号图文验证'
        self.write()
        plan = module.preflight(self.folder, config, 'save_draft', None)
        self.assertEqual(plan['platform'], 'DYNAMIC_WEIXIN')
        self.assertEqual(plan['data']['content'], (self.folder / 'body.md').read_text().rstrip())
        self.assertEqual(len(plan['data']['images']), 1)
        with self.assertRaisesRegex(ValueError, 'save_draft'):
            module.preflight(self.folder, config, 'prepare', None)
        self.metadata['content'] = 'x' * 1000
        self.metadata.pop('bodyFile')
        self.write()
        with self.assertRaisesRegex(ValueError, '1000'):
            module.preflight(self.folder, config, 'save_draft', None)


class AutomaticDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_state = module.STATE
        module.STATE = Path(self.temp.name) / 'state'
        self.folder = Path(self.temp.name) / 'content'
        shutil.copytree(FIXTURES / 'dynamic/image-card-rednote', self.folder)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), module.Handler)
        self.server.api_token = 'admin-test'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.extension_id = 'a' * 32
        pairing = self.call('/pairing', {}, admin=True)[1]
        token = pairing['pairingUrl'].split('#')[1]
        self.pair_token = token
        self.executor_token = self.call('/pair-claim', {'token': token, 'extensionId': self.extension_id})[1]['executorToken']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        module.STATE = self.previous_state
        self.temp.cleanup()

    def call(self, path, body=None, admin=False, executor=False, token=None):
        headers = {'Host': 'localhost:2663', 'Content-Type': 'application/json'}
        if admin:
            headers['Authorization'] = 'Bearer admin-test'
        if executor:
            headers.update(Authorization='Bearer ' + (token or self.executor_token), **{'X-MultiPost-Extension-Id': self.extension_id})
        req = Request(f'http://127.0.0.1:{self.server.server_port}' + path, headers=headers, data=None if body is None else json.dumps(body).encode())
        try:
            response = build_opener(ProxyHandler({})).open(req)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def submit(self):
        return self.call('/submit', {'folder': str(self.folder), 'platforms': 'DYNAMIC_REDNOTE'}, admin=True)[1]

    def test_background_poll_claims_once_without_bridge_page(self):
        task = self.submit()
        self.assertNotIn('bridgeUrl', task)
        code, claim = self.call('/next', executor=True)
        self.assertEqual(code, 200)
        self.assertEqual(claim['taskId'], task['taskId'])
        self.assertTrue(claim['data']['images'][0]['url'].startswith('data:image/png;base64,'))
        self.assertEqual(self.call('/resume', {'taskId': task['taskId']}, admin=True)[0], 400)
        self.assertEqual(self.call('/next', executor=True)[0], 204)
        self.assertTrue(self.call('/connection', admin=True)[1]['online'])

    def test_invalid_executor_and_reused_pairing_cannot_claim(self):
        self.submit()
        self.assertEqual(self.call('/next', executor=True, token='wrong')[0], 400)
        self.assertEqual(self.call('/pair-claim', {'token': self.pair_token, 'extensionId': self.extension_id})[0], 400)
        self.assertEqual(self.call('/next', executor=True)[0], 200)

    def test_changed_material_fails_before_plugin_delivery(self):
        task = self.submit()
        (self.folder / 'test-card.png').write_bytes(b'changed')
        self.assertEqual(self.call('/next', executor=True)[0], 204)
        receipt = self.call('/status?taskId=' + task['taskId'], admin=True)[1]['receipt']
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['code'], 'MATERIAL_CHANGED')

    def test_channel_publish_claim_keeps_prepared_media_evidence(self):
        code, source = self.call('/submit', {'folder': str(self.folder),
                                             'platforms': 'DYNAMIC_WEIXINCHANNEL',
                                             'action': 'prepare'}, admin=True)
        self.assertEqual(code, 200)
        path = module.task_path(source['taskId'])
        saved = module.load_task(path)
        saved['receipt'] = {'status': 'filled', 'tabId': 42,
                            'evidence': {'imageCount': 1, 'imageSources': ['blob:card']}}
        module.atomic(path, saved)
        code, publish = self.call('/publish', {'taskId': source['taskId']}, admin=True)
        self.assertEqual(code, 200)
        self.assertEqual(publish['action'], 'publish')
        code, claim = self.call('/next', executor=True)
        self.assertEqual(code, 200)
        self.assertEqual(claim['sourceTaskId'], source['taskId'])
        self.assertEqual(claim['sourceTabId'], 42)
        self.assertEqual(claim['preparedEvidence']['imageSources'], ['blob:card'])


if __name__ == '__main__':
    unittest.main()
