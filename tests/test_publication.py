import importlib.util
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/qiushui-fast-publish/scripts/multipost.py'
spec = importlib.util.spec_from_file_location('multipost_publication_test', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / '05-作品/测试'
        self.folder.mkdir(parents=True)
        (self.root / '00-约定').mkdir()
        (self.root / '00-约定/发布规范.md').write_text('''# 发布规范
- 目标动作：存草稿。
- 定时发表：关闭，时间为空。
- 声明原创：本人原创内容默认开启。
- 默认账号：各平台的“我叫秋水”账号，执行前核对实际身份。
''')
        (self.folder / '发布文案.md').write_text('''# 发布文案
## 目标平台
- [x] 视频号
## 视频号
### 标题
AI开发先说清需求
### 描述
让AI读代码并验证结果。
### 话题
- AI开发
### 合集
无
''')
        (self.folder / '视频.mp4').write_bytes(b'\x00\x00\x00\x18ftypisom' + b'0' * 64)
        (self.folder / '封面-竖版.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'0' * 32)
        self.specification = {
            '作品': '测试', '时区': 'Asia/Shanghai', '视频文件': '视频.mp4',
            '来源文件': ['05-作品/测试/发布文案.md', '00-约定/发布规范.md'],
            '平台任务': [{'平台': '视频号', '账号': {'名称': '我叫秋水', '账号ID': 'verified_id'},
                '封面': {'竖版': '封面-竖版.png', '横版': None}, '标题': 'AI开发先说清需求',
                '描述': '让AI读代码并验证结果。', '话题': ['AI开发'], '合集': None,
                '定时发表': False, '定时发表时间': None, '声明原创': True, '目标动作': '存草稿', '待补充': []}]}

    def generate(self):
        return m.publication.generate(self.folder, copy.deepcopy(self.specification), self.root)

    def plans(self, subset=None):
        return m.configured_plans(self.folder, m.DEFAULT_CONFIG, subset, chinese=True)

    def change(self, **fields):
        task = json.loads((self.folder / '发布任务.json').read_text())
        task['平台任务'][0].update(fields)
        (self.folder / '发布任务.json').write_text(json.dumps(task))

    def test_defaults_mapping_and_stable_batch(self):
        first = self.generate()
        self.assertEqual(self.generate(), first)
        item = first['平台任务'][0]
        self.assertFalse(item['定时发表'])
        self.assertIsNone(item['定时发表时间'])
        self.assertTrue(item['声明原创'])
        plans = self.plans()
        self.assertEqual(plans[0]['action'], 'save_draft')
        self.assertEqual(plans[0]['data']['tags'], ['AI开发'])
        self.assertEqual(plans[0]['data']['expectedAccountId'], 'verified_id')
        self.assertEqual(plans, self.plans('视频号'))

    def test_missing_identity_is_not_inferred_from_nickname(self):
        self.specification['平台任务'][0]['账号']['账号ID'] = None
        self.generate()
        with self.assertRaisesRegex(ValueError, '稳定账号ID缺失'):
            self.plans()

    def test_changed_source_invalidates_snapshot_and_regeneration_changes_batch(self):
        first = self.generate()
        p = self.folder / '发布文案.md'
        p.write_text(p.read_text().replace('AI开发先说清需求', 'AI开发要验证结果'))
        with self.assertRaisesRegex(ValueError, '来源已变化'):
            self.plans()
        self.assertNotEqual(first['任务批次ID'], self.generate()['任务批次ID'])

    def test_changed_video_and_cover_are_rejected(self):
        self.generate()
        p = self.folder / '视频.mp4'
        original = p.read_bytes()
        p.write_bytes(original + b'changed')
        with self.assertRaisesRegex(ValueError, '视频缺失或已变化'):
            self.plans()
        p.write_bytes(original)
        (self.folder / '封面-竖版.png').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, '封面已变化'):
            self.plans()

    def test_unresolved_collection_is_not_none_intent(self):
        p = self.folder / '发布文案.md'
        p.write_text(p.read_text().replace('### 合集\n无', '### 合集\n待补充'))
        self.specification['平台任务'][0]['待补充'] = ['合集']
        self.generate()
        with self.assertRaisesRegex(ValueError, '合集'):
            self.plans()

    def test_unsupported_fields_and_invalid_action_fail_before_connection(self):
        self.generate()
        cases = [({'定时发表': True, '定时发表时间': '2027-01-01T12:00:00+08:00'}, '定时'),
                 ({'合集': '学习AI'}, '合集'), ({'目标动作': '未知'}, '目标动作')]
        for values, message in cases:
            with self.subTest(values=values):
                self.generate()
                self.change(**values)
                with patch.object(m, 'request') as request:
                    with self.assertRaisesRegex(ValueError, message):
                        self.plans()
                    request.assert_not_called()

    def test_subset_cannot_add_platform(self):
        self.generate()
        with self.assertRaisesRegex(ValueError, '只能缩小'):
            self.plans('抖音')

    def test_media_path_cannot_escape_work(self):
        self.generate()
        task = json.loads((self.folder / '发布任务.json').read_text())
        task['视频文件'] = '../outside.mp4'
        (self.folder / '发布任务.json').write_text(json.dumps(task))
        with self.assertRaisesRegex(ValueError, '越出目录'):
            self.plans()

    def test_final_action_uses_linked_preparation_and_idempotent_upload(self):
        self.generate()
        filled = {'taskId': 'prepared', 'receipt': {'status': 'filled'}}
        for action, endpoint, status in [('save_draft', '/save-video-draft', 'draft_saved'), ('publish', '/publish', 'published'), ('prepare', None, 'filled')]:
            plan = self.plans()[0]
            plan['action'] = action
            final = {'taskId': 'final', 'receipt': {'status': status}}
            with self.subTest(action=action), patch.object(m, 'request', side_effect=[filled, final]) as request, patch.object(m, 'wait_for_terminal', side_effect=[filled, final]):
                result = m.execute_plan(self.folder, m.DEFAULT_CONFIG, plan, 1)
                self.assertEqual(request.call_args_list[0].args[1]['action'], 'prepare')
                self.assertEqual(request.call_args_list[0].args[1]['idempotencyKey'], plan['idempotencyKey'])
                self.assertEqual(request.call_count, 2 if endpoint else 1)
                if endpoint:
                    self.assertEqual(request.call_args_list[1].args, (endpoint, {'taskId': 'prepared'}))
                self.assertEqual(result['receipt']['status'], status)

    def test_preparation_failure_never_saves_or_publishes(self):
        self.generate()
        plan = self.plans()[0]
        bad = {'taskId': 'prepared', 'receipt': {'status': 'result_unconfirmed'}}
        with patch.object(m, 'request', return_value=bad) as request, patch.object(m, 'wait_for_terminal', return_value=bad):
            self.assertEqual(m.execute_plan(self.folder, m.DEFAULT_CONFIG, plan, 1), bad)
            self.assertEqual(request.call_count, 1)

    def test_public_run_requires_explicit_flag_before_connecting(self):
        self.generate()
        self.change(目标动作='直接发布')
        with patch('sys.argv', ['multipost.py', 'run-video-task', str(self.folder)]), patch.object(m, 'request') as request:
            self.assertEqual(m.main(), 2)
            request.assert_not_called()

    def test_rules_are_hashed_not_parsed_and_media_name_is_explicit(self):
        (self.root / '00-约定/发布规范.md').write_text('规则文字可自由修改，参数由调用者明确提供。')
        (self.folder / '视频.mp4').rename(self.folder / 'custom.mp4')
        self.specification['视频文件'] = 'custom.mp4'
        task = self.generate()
        self.assertEqual(task['视频文件'], 'custom.mp4')
        self.assertEqual(self.plans()[0]['data']['video']['name'], 'custom.mp4')

    def test_missing_explicit_original_does_not_get_default(self):
        del self.specification['平台任务'][0]['声明原创']
        with self.assertRaisesRegex(ValueError, '不自动补默认值'):
            self.generate()

    def test_chinese_snapshot_does_not_hijack_legacy_content(self):
        self.generate()
        (self.folder / 'content.json').write_text(json.dumps({
            'type': 'DYNAMIC', 'title': '旧图文', 'content': '旧正文', 'images': ['封面-竖版.png']}))
        plan = m.preflight(self.folder, m.DEFAULT_CONFIG, 'prepare', 'DYNAMIC_REDNOTE')
        self.assertEqual(plan['data']['content'], '旧正文')
        self.assertEqual(self.plans()[0]['data']['content'], '让AI读代码并验证结果。')


if __name__ == '__main__':
    unittest.main()
