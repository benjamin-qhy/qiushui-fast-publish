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

    def test_expected_account_survives_preflight_and_invalid_id_is_rejected(self):
        self.metadata['expectedAccountId'] = 'stable_account'
        self.write()
        self.assertEqual(self.plan()['data']['expectedAccountId'], 'stable_account')
        self.metadata['expectedAccountId'] = ' '
        self.write()
        with self.assertRaisesRegex(ValueError, 'expectedAccountId'):
            self.plan()

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

    def test_channel_short_title_limits_and_allowed_symbols(self):
        folder = Path(self.temp.name) / 'short-title'
        shutil.copytree(FIXTURES / 'video/weixinchannel-prepare', folder)
        config = Path(self.temp.name) / 'short-title.json'
        config.write_text(json.dumps({'VIDEO': ['VIDEO_WEIXINCHANNEL']}))
        metadata = module.read_metadata(folder / 'content.yaml')
        (folder / 'content.yaml').unlink()
        for title in ['中' * 16, 'AI开发不稳定 先解决这两点', '《AI》：“好”+？%℃']:
            metadata['title'] = title
            (folder / 'content.json').write_text(json.dumps(metadata))
            self.assertEqual(module.preflight(folder, config, 'prepare', None)['data']['title'], title)
        for title in ['中' * 17, 'AI开发不稳定，先解决', 'AI,开发', 'AI开发!', 'AI开发。', 'AI开发\n测试']:
            metadata['title'] = title
            (folder / 'content.json').write_text(json.dumps(metadata))
            with self.assertRaises(ValueError):
                module.preflight(folder, config, 'prepare', None)

    def test_three_video_platforms_preserve_covers_account_and_reject_direct_publish(self):
        folder = Path(self.temp.name) / 'video-all'
        shutil.copytree(FIXTURES / 'video/weixinchannel-prepare', folder)
        shutil.copyfile(self.folder / 'test-card.png', folder / 'cover.png')
        config = Path(self.temp.name) / 'video-all.json'
        platforms = sorted(module.VIDEO_PLATFORMS)
        config.write_text(json.dumps({'VIDEO': platforms}))
        metadata = {'type': 'VIDEO', 'title': 'AI需求澄清', 'content': '正文', 'video': 'test.mp4', 'cover': 'cover.png', 'expectedAccountId': 'target_account', 'visibility': '公开'}
        (folder / 'content.yaml').unlink(missing_ok=True)
        for platform in platforms:
            with self.subTest(platform=platform):
                (folder / 'content.json').write_text(json.dumps(metadata))
                plan = module.preflight(folder, config, 'prepare', platform)
                self.assertEqual(plan['data']['expectedAccountId'], 'target_account')
                self.assertEqual(len(plan['data']['cover']['sha256']), 64)
                with self.assertRaisesRegex(ValueError, '原任务'):
                    module.preflight(folder, config, 'publish', platform)
                metadata['scheduledPublishTime'] = 1
                (folder / 'content.json').write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, 'scheduledPublishTime'):
                    module.preflight(folder, config, 'prepare', platform)
                metadata.pop('scheduledPublishTime')
                metadata.update(tags=['AI开发', '需求澄清'], scheduledPublishTime=0, original=False, description='正文', category=None, collectionId=None)
                (folder / 'content.json').write_text(json.dumps(metadata))
                detailed = module.preflight(folder, config, 'prepare', platform)['data']
                self.assertEqual(detailed['tags'], ['AI开发', '需求澄清'])
                self.assertIs(detailed['original'], False)
                self.assertEqual(detailed['scheduledPublishTime'], 0)
                for invalid in [dict(original='true'), dict(tags=['重复', '重复']), dict(tags=['#格式错误']), dict(scheduledPublishTime=False)]:
                    (folder / 'content.json').write_text(json.dumps({**metadata, **invalid}))
                    with self.assertRaises(ValueError):
                        module.preflight(folder, config, 'prepare', platform)

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

    def call(self, path, body=None, admin=False, executor=False, token=None, video=False):
        headers = {'Host': 'localhost:2663', 'Content-Type': 'application/json'}
        if admin:
            headers['Authorization'] = 'Bearer admin-test'
        if executor:
            headers.update(Authorization='Bearer ' + (token or self.executor_token), **{'X-MultiPost-Extension-Id': self.extension_id})
        if video:
            headers['X-FastPublish-Video-Tasks'] = '1'
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

    def test_submit_key_recovers_same_task_and_rejects_changed_material(self):
        import uuid
        body = {'folder': str(self.folder), 'platforms': 'DYNAMIC_REDNOTE', 'idempotencyKey': str(uuid.uuid4())}
        first = self.call('/submit', body, admin=True)
        second = self.call('/submit', body, admin=True)
        self.assertEqual(first[0], 200)
        self.assertEqual(first[1]['taskId'], second[1]['taskId'])
        self.assertEqual(len(list((module.STATE / 'tasks').glob('*.json'))), 1)
        metadata = module.read_metadata(self.folder / 'content.yaml')
        metadata['title'] = '已经改稿'
        (self.folder / 'content.yaml').unlink()
        (self.folder / 'content.json').write_text(json.dumps(metadata))
        self.assertEqual(self.call('/submit', body, admin=True)[0], 400)

    def test_connection_distinguishes_old_and_video_capable_executor(self):
        self.call('/next', executor=True)
        self.assertIsNone(self.call('/connection', admin=True)[1]['videoTaskProtocol'])
        self.call('/next', executor=True, video=True)
        self.assertEqual(self.call('/connection', admin=True)[1]['videoTaskProtocol'], 1)

    def test_video_submit_requires_bound_account_but_offline_plan_is_allowed(self):
        folder = Path(self.temp.name) / 'bound-video'
        shutil.copytree(FIXTURES / 'video/weixinchannel-prepare', folder)
        config = Path(self.temp.name) / 'video.json'
        config.write_text(json.dumps({'VIDEO': ['VIDEO_WEIXINCHANNEL']}))
        self.call('/next', executor=True, video=True)
        body = {'folder': str(folder), 'config': str(config), 'platforms': 'VIDEO_WEIXINCHANNEL', 'action': 'prepare'}
        self.assertEqual(self.call('/submit', body, admin=True)[0], 400)
        self.assertEqual(module.preflight(folder, config, 'prepare', None)['platform'], 'VIDEO_WEIXINCHANNEL')
        metadata = module.read_metadata(folder / 'content.yaml')
        (folder / 'content.yaml').unlink()
        metadata['expectedAccountId'] = 'confirmed_account'
        (folder / 'content.json').write_text(json.dumps(metadata))
        self.assertEqual(self.call('/submit', body, admin=True)[0], 200)

    def test_append_horizontal_cover_keeps_original_video_text_and_account(self):
        import uuid
        folder = Path(self.temp.name) / 'dual-cover'
        shutil.copytree(FIXTURES / 'video/weixinchannel-prepare', folder)
        shutil.copyfile(self.folder / 'test-card.png', folder / 'portrait.png')
        shutil.copyfile(self.folder / 'test-card.png', folder / 'landscape.png')
        config = Path(self.temp.name) / 'dual.json'
        config.write_text(json.dumps({'VIDEO': ['VIDEO_DOUYIN']}))
        metadata = module.read_metadata(folder / 'content.yaml')
        (folder / 'content.yaml').unlink()
        metadata.update(cover='portrait.png', expectedAccountId='same_account')
        (folder / 'content.json').write_text(json.dumps(metadata))
        original = module.preflight(folder, config, 'prepare', None)
        task = {**original, 'taskId': str(uuid.uuid4()), 'operation': 'start', 'createdAt': time.time(), 'updatedAt': time.time(),
                'receipt': {'status': 'needs_attention', 'tabId': 7, 'evidence': {'videoUploadStarted': True}}}
        module.atomic(module.task_path(task['taskId']), task)
        metadata['horizontalCover'] = 'landscape.png'
        (folder / 'content.json').write_text(json.dumps(metadata))
        body = {'taskId': task['taskId'], 'addHorizontalCover': True, 'folder': str(folder), 'config': str(config)}
        self.assertEqual(self.call('/resume', body, admin=True)[0], 200)
        updated = module.load_task(module.task_path(task['taskId']))
        self.assertEqual(updated['data']['video'], original['data']['video'])
        self.assertEqual(updated['data']['expectedAccountId'], 'same_account')
        self.assertEqual(updated['data']['horizontalCover']['name'], 'landscape.png')
        self.assertEqual(len(updated['coverChanges']), 1)
        updated['receipt']['status'] = 'needs_attention'
        module.atomic(module.task_path(task['taskId']), updated)
        metadata['title'] = '不允许换标题'
        (folder / 'content.json').write_text(json.dumps(metadata))
        self.assertEqual(self.call('/resume', body, admin=True)[0], 400)
        self.assertEqual(module.load_task(module.task_path(task['taskId']))['data']['title'], original['data']['title'])

    def test_video_cover_step_is_explicit_and_cannot_request_draft_or_publication(self):
        import uuid
        task = {'taskId': str(uuid.uuid4()), 'platform': 'VIDEO_REDNOTE', 'action': 'prepare', 'operation': 'start',
                'createdAt': time.time(), 'updatedAt': time.time(), 'data': {'title': 'title', 'content': 'body'},
                'receipt': {'status': 'needs_attention', 'tabId': 7, 'evidence': {'videoUploadStarted': True}}}
        module.atomic(module.task_path(task['taskId']), task)
        for step in ['publish', 'save_draft']:
            self.assertEqual(self.call('/resume', {'taskId': task['taskId'], 'videoStep': step}, admin=True)[0], 400)
        self.assertEqual(self.call('/resume', {'taskId': task['taskId'], 'videoStep': 'open_cover'}, admin=True)[0], 200)
        resumed = module.load_task(module.task_path(task['taskId']))
        self.assertEqual(resumed['videoStep'], 'open_cover')
        self.assertEqual(module.claim_task(resumed)['videoStep'], 'open_cover')
        resumed['receipt']['status'] = 'needs_attention'
        module.atomic(module.task_path(task['taskId']), resumed)
        self.assertEqual(self.call('/resume', {'taskId': task['taskId']}, admin=True)[0], 200)
        self.assertNotIn('videoStep', module.load_task(module.task_path(task['taskId'])))

    def test_video_account_tasks_are_read_only_and_platform_scoped(self):
        for platform in sorted(module.VIDEO_PLATFORMS):
            response = self.call('/account', {'platform': platform}, admin=True)
            self.assertEqual(response[0], 200)
            task = module.load_task(module.task_path(response[1]['taskId']))
            self.assertEqual(task['platform'], platform)
            self.assertEqual(task['operation'], 'account')
            self.assertNotIn('video', task['data'])
        self.assertEqual(self.call('/account', {'platform': 'VIDEO_UNKNOWN'}, admin=True)[0], 400)

    def test_video_claim_preserves_upload_intent_and_all_cover_hashes(self):
        import uuid
        video = module.video_file(FIXTURES / 'video/weixinchannel-prepare', 'test.mp4')
        image = module.media_file(self.folder, module.read_metadata(self.folder / 'content.yaml')['images'][0])
        task = {'taskId': str(uuid.uuid4()), 'platform': 'VIDEO_WEIXINCHANNEL', 'action': 'prepare', 'operation': 'resume',
                'data': {'title': 'test', 'content': 'body', 'video': video, 'verticalCover': image, 'horizontalCover': image},
                'callbackToken': 'test', 'createdAt': time.time(), 'updatedAt': time.time(),
                'receipt': {'status': 'queued', 'tabId': 42, 'evidence': {'videoUploadStarted': True}}}
        packed = module.claim_task(task)
        self.assertTrue(packed['previousReceipt']['evidence']['videoUploadStarted'])
        self.assertEqual(packed['previousReceipt']['tabId'], 42)
        for field in ['video', 'verticalCover', 'horizontalCover']:
            self.assertEqual(packed['data'][field]['sha256'], task['data'][field]['sha256'])
            self.assertTrue(packed['data'][field]['url'].startswith('data:'))

    def test_video_publish_is_linked_idempotent_and_unknown_result_cannot_repeat(self):
        import uuid
        self.assertEqual(self.call('/next', executor=True, video=True)[0], 204)
        for platform in sorted(module.VIDEO_PLATFORMS):
            task = {'taskId': str(uuid.uuid4()), 'platform': platform, 'action': 'prepare',
                    'data': {'title': 'test', 'content': 'body'}, 'createdAt': time.time(), 'updatedAt': time.time(),
                    'receipt': {'status': 'filled', 'tabId': 42, 'evidence': {'videoSources': ['blob:one']}}}
            module.atomic(module.task_path(task['taskId']), task)
            self.assertEqual(self.call('/publish', {'taskId': task['taskId']}, admin=True)[0], 400)
            task['data']['expectedAccountId'] = 'target'
            module.atomic(module.task_path(task['taskId']), task)
            first = self.call('/publish', {'taskId': task['taskId']}, admin=True)
            second = self.call('/publish', {'taskId': task['taskId']}, admin=True)
            self.assertEqual(first[0], 200)
            self.assertEqual(first[1]['taskId'], second[1]['taskId'])
            # Simulate interruption after the linked task was persisted but before
            # the source pointer was written.
            original = module.load_task(module.task_path(task['taskId']))
            original.pop('publishTaskId')
            module.atomic(module.task_path(task['taskId']), original)
            recovered = self.call('/publish', {'taskId': task['taskId']}, admin=True)
            self.assertEqual(recovered[1]['taskId'], first[1]['taskId'])
            publish = module.load_task(module.task_path(first[1]['taskId']))
            self.assertEqual(publish['sourceTabId'], 42)
            self.assertEqual(publish['preparedEvidence']['videoSources'], ['blob:one'])
            publish['receipt'] = {'status': 'result_unconfirmed', 'code': 'PUBLISH_RESULT_NOT_CONFIRMED'}
            module.atomic(module.task_path(publish['taskId']), publish)
            self.assertEqual(self.call('/publish-resume', {'taskId': publish['taskId']}, admin=True)[0], 400)
            self.assertEqual(self.call('/resume', {'taskId': publish['taskId']}, admin=True)[0], 400)
            self.assertEqual(self.call('/reconcile', {'taskId': publish['taskId']}, admin=True)[0], 200)

    def test_video_draft_is_linked_once_and_reconcile_cannot_click_again(self):
        import uuid
        executor_path = module.STATE / 'executor.json'
        executor = json.loads(executor_path.read_text())
        executor['videoTaskRevision'] = 22
        module.atomic(executor_path, executor)
        source = {'taskId': str(uuid.uuid4()), 'platform': 'VIDEO_WEIXINCHANNEL', 'action': 'prepare',
                  'data': {'expectedAccountId': 'target'}, 'createdAt': time.time(), 'updatedAt': time.time(),
                  'receipt': {'status': 'needs_attention', 'tabId': 42}}
        module.atomic(module.task_path(source['taskId']), source)
        self.assertEqual(self.call('/save-video-draft', {'taskId': source['taskId']}, admin=True)[0], 400)
        source['receipt']['status'] = 'filled'
        module.atomic(module.task_path(source['taskId']), source)
        first = self.call('/save-video-draft', {'taskId': source['taskId']}, admin=True)
        self.assertEqual(first[0], 200)
        self.assertEqual(self.call('/save-video-draft', {'taskId': source['taskId']}, admin=True)[1]['taskId'], first[1]['taskId'])
        task = module.load_task(module.task_path(first[1]['taskId']))
        self.assertEqual(task['sourceTabId'], 42)
        self.assertEqual(task['operation'], 'save_draft')
        task['receipt'] = {'status': 'result_unconfirmed'}
        module.atomic(module.task_path(task['taskId']), task)
        self.assertEqual(self.call('/save-video-draft', {'taskId': source['taskId']}, admin=True)[1]['receipt']['status'], 'result_unconfirmed')
        self.assertEqual(self.call('/resume', {'taskId': task['taskId']}, admin=True)[0], 400)
        self.assertEqual(self.call('/reconcile-video-draft', {'taskId': task['taskId']}, admin=True)[0], 200)
        reconciled = module.load_task(module.task_path(task['taskId']))
        self.assertEqual(reconciled['operation'], 'reconcile_draft')
        packed = module.claim_task(reconciled)
        self.assertEqual(packed['operation'], 'reconcile_draft')
        self.assertNotIn('videoStep', packed)

    def test_draft_title_repair_requires_explicit_platform_rejection_and_changes_only_title(self):
        import uuid
        source = {'taskId': str(uuid.uuid4()), 'platform': 'VIDEO_WEIXINCHANNEL', 'action': 'prepare',
                  'data': {'title': '旧标题，', 'content': 'same body', 'expectedAccountId': 'target'},
                  'createdAt': time.time(), 'updatedAt': time.time(), 'receipt': {'status': 'filled', 'tabId': 42}}
        module.atomic(module.task_path(source['taskId']), source)
        draft = {'taskId': str(uuid.uuid4()), 'sourceTaskId': source['taskId'], 'sourceTabId': 42,
                 'platform': source['platform'], 'action': 'save_draft', 'data': source['data'],
                 'preparedEvidence': {}, 'createdAt': time.time(), 'updatedAt': time.time(),
                 'receipt': {'status': 'result_unconfirmed'}}
        module.atomic(module.task_path(draft['taskId']), draft)
        body = {'taskId': draft['taskId'], 'folder': 'unused'}
        self.assertEqual(self.call('/repair-video-draft-title', body, admin=True)[0], 400)
        draft['receipt'] = {'status': 'needs_attention', 'code': 'DRAFT_TITLE_REJECTED', 'evidence': {'draftTitleRejected': True}}
        module.atomic(module.task_path(draft['taskId']), draft)
        revised = {**source['data'], 'title': 'AI开发不稳定 先解决这两点'}
        with patch.object(module, 'preflight', return_value={'data': {**revised, 'content': 'changed'}}):
            self.assertEqual(self.call('/repair-video-draft-title', body, admin=True)[0], 400)
        with patch.object(module, 'preflight', return_value={'data': revised}):
            self.assertEqual(self.call('/repair-video-draft-title', body, admin=True)[0], 200)
        repaired = module.load_task(module.task_path(draft['taskId']))
        self.assertEqual(repaired['operation'], 'repair_draft_title')
        self.assertEqual(repaired['preparedEvidence']['previousTitle'], source['data']['title'])
        receipt = {'taskId': draft['taskId'], 'platform': source['platform'], 'action': 'save_draft',
                   'status': 'needs_attention', 'code': 'TITLE_REPAIRED_READY', 'tabId': 42, 'evidence': {'titleMatched': True}}
        self.assertEqual(self.call('/result', {'taskId': draft['taskId'], 'token': repaired['callbackToken'], 'receipt': receipt})[0], 200)
        updated = module.load_task(module.task_path(source['taskId']))
        self.assertEqual(updated['data'], revised)
        self.assertEqual(updated['receipt']['status'], 'filled')
        self.assertEqual(len(updated['preparationHistory']), 1)

    def test_channel_single_cover_adaptation_preserves_video_text_and_account(self):
        import uuid
        data = {'title': 'title', 'content': 'body', 'expectedAccountId': 'target', 'horizontalCover': {'sha256': 'original-horizontal'}}
        task = {'taskId': str(uuid.uuid4()), 'platform': 'VIDEO_WEIXINCHANNEL', 'action': 'prepare',
                'data': data, 'createdAt': time.time(), 'updatedAt': time.time(),
                'receipt': {'status': 'needs_attention', 'tabId': 42, 'evidence': {'videoUploadStarted': True,
                            'coverNodes': [{'className': 'cover-preview-wrap', 'text': '个人主页和分享卡片(3:4)'}]}}}
        module.atomic(module.task_path(task['taskId']), task)
        expected = {k: v for k, v in data.items() if k != 'horizontalCover'}
        body = {'taskId': task['taskId'], 'omitUnsupportedHorizontalCover': True, 'folder': 'unused'}
        with patch.object(module, 'preflight', return_value={'data': {**expected, 'title': 'changed'}}):
            self.assertEqual(self.call('/resume', body, admin=True)[0], 400)
        with patch.object(module, 'preflight', return_value={'data': expected}):
            self.assertEqual(self.call('/resume', body, admin=True)[0], 200)
        adapted = module.load_task(module.task_path(task['taskId']))
        self.assertEqual(adapted['data'], expected)
        self.assertEqual(adapted['coverChanges'][0]['previous'], data['horizontalCover'])
        self.assertEqual(adapted['operation'], 'resume')

    def test_draft_inspection_uses_separate_read_task_without_saving_again(self):
        import uuid
        path = module.STATE / 'executor.json'
        executor = json.loads(path.read_text())
        executor['videoTaskRevision'] = 27
        module.atomic(path, executor)
        source = {'taskId': str(uuid.uuid4()), 'sourceTaskId': str(uuid.uuid4()), 'platform': 'VIDEO_WEIXINCHANNEL',
                  'action': 'save_draft', 'operation': 'save_draft', 'data': {'title': 'same title', 'expectedAccountId': 'target'},
                  'createdAt': time.time(), 'updatedAt': time.time(), 'receipt': {'status': 'result_unconfirmed', 'tabId': 42}}
        module.atomic(module.task_path(source['taskId']), source)
        first = self.call('/inspect-video-drafts', {'taskId': source['taskId']}, admin=True)
        self.assertEqual(first[0], 200)
        self.assertEqual(self.call('/inspect-video-drafts', {'taskId': source['taskId']}, admin=True)[1]['taskId'], first[1]['taskId'])
        task = module.load_task(module.task_path(first[1]['taskId']))
        self.assertEqual(task['operation'], 'inspect_drafts')
        self.assertEqual(task['draftSourceTaskId'], source['taskId'])
        self.assertNotIn('sourceTabId', task)
        self.assertEqual(module.load_task(module.task_path(source['taskId'])), source)
        self.assertEqual(module.claim_task(task)['operation'], 'inspect_drafts')
        receipt = {'taskId': task['taskId'], 'platform': source['platform'], 'action': 'save_draft', 'status': 'draft_saved', 'tabId': 99, 'evidence': {'draftBodyMatched': True}}
        self.assertEqual(self.call('/result', {'taskId': task['taskId'], 'token': task['callbackToken'], 'receipt': receipt})[0], 200)
        confirmed = module.load_task(module.task_path(source['taskId']))
        self.assertEqual(confirmed['receipt']['status'], 'draft_saved')
        self.assertEqual(confirmed['receipt']['tabId'], 42)
        self.assertEqual(confirmed['receipt']['evidence']['draftReadbackTabId'], 99)
        self.assertNotIn('publishTaskId', confirmed)
        readback = module.load_task(module.task_path(task['taskId']))
        readback['receipt'] = {'status': 'failed', 'code': 'EXECUTION_ERROR'}
        module.atomic(module.task_path(readback['taskId']), readback)
        self.assertEqual(self.call('/reconcile-video-draft', {'taskId': readback['taskId']}, admin=True)[0], 200)
        self.assertEqual(module.load_task(module.task_path(readback['taskId']))['operation'], 'reconcile_draft')

    def test_collection_requires_published_work_and_is_read_only(self):
        import uuid
        source = self.submit()
        body = {'taskId': source['taskId'], 'idempotencyKey': str(uuid.uuid4())}
        self.assertEqual(self.call('/collect', body, admin=True)[0], 400)
        task = module.load_task(module.task_path(source['taskId']))
        task['receipt'] = {'status': 'published', 'evidence': {'noteId': 'a' * 24}}
        module.atomic(module.task_path(source['taskId']), task)
        first = self.call('/collect', body, admin=True)
        second = self.call('/collect', body, admin=True)
        self.assertEqual(first[0], 200)
        self.assertEqual(first[1]['taskId'], second[1]['taskId'])
        claim = self.call('/next', executor=True)[1]
        self.assertEqual(claim['operation'], 'collect')
        self.assertEqual(claim['data']['noteId'], 'a' * 24)
        self.assertEqual(claim['data']['images'], [])

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
