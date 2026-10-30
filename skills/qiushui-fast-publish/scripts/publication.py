"""Chinese video publication snapshots; local generation and validation only."""
import hashlib
import json
import copy
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

PLATFORMS = {'视频号': 'VIDEO_WEIXINCHANNEL', '小红书': 'VIDEO_REDNOTE', '抖音': 'VIDEO_DOUYIN'}
ACTIONS = {'填完保持不动': 'prepare', '存草稿': 'save_draft', '直接发布': 'publish'}
NAME = '发布任务.json'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def within(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'文件不存在或越出目录：{name}')
    return path


def validate_fields(task):
    if not isinstance(task, dict) or not isinstance(task.get('作品'), str) or not task['作品'].strip():
        raise ValueError('任务须明确作品名称')
    if task.get('时区') != 'Asia/Shanghai':
        raise ValueError('当前任务时区须明确为Asia/Shanghai')
    if not isinstance(task.get('视频文件'), (str, type(None))):
        raise ValueError('视频文件须为相对路径或null')
    sources = task.get('来源文件')
    if not isinstance(sources, list) or not sources:
        raise ValueError('须明确非空来源文件列表')
    items = task.get('平台任务')
    if not isinstance(items, list) or not items:
        raise ValueError('平台任务须为非空列表')
    names = []
    required = {'平台', '账号', '封面', '标题', '描述', '话题', '合集', '定时发表', '定时发表时间', '声明原创', '目标动作', '待补充'}
    for item in items:
        if not isinstance(item, dict) or required - set(item):
            raise ValueError('平台任务缺少明确字段；不自动补默认值')
        if item['平台'] not in PLATFORMS or item['平台'] in names:
            raise ValueError('平台须已接通且不重复')
        names.append(item['平台'])
        if not isinstance(item['账号'], dict) or set(item['账号']) != {'名称', '账号ID'}:
            raise ValueError('账号须明确名称和账号ID')
        if any(not isinstance(v, (str, type(None))) for v in item['账号'].values()):
            raise ValueError('账号名称和ID须为字符串或null')
        if not isinstance(item['封面'], dict) or set(item['封面']) != {'竖版', '横版'}:
            raise ValueError('封面须明确竖版和横版路径')
        if any(not isinstance(v, (str, type(None))) for v in item['封面'].values()):
            raise ValueError('封面路径须为字符串或null')
        if not isinstance(item['待补充'], list) or not all(isinstance(v, str) for v in item['待补充']):
            raise ValueError('待补充须为字符串列表')
        if type(item['定时发表']) is not bool or type(item['声明原创']) is not bool:
            raise ValueError('定时发表和声明原创须为明确布尔值')
        if item['目标动作'] not in ACTIONS:
            raise ValueError('目标动作无效')
        for key in ['标题', '描述', '合集', '定时发表时间']:
            if not isinstance(item[key], (str, type(None))):
                raise ValueError(key + '须为字符串或null')
        if item['话题'] is not None and (not isinstance(item['话题'], list) or not all(isinstance(v, str) for v in item['话题'])):
            raise ValueError('话题须为字符串列表或null')


def generate(folder, specification, source_root=None):
    """Seal explicit values supplied by the caller; never interpret business notes."""
    folder = Path(folder).resolve()
    root = Path(source_root).resolve() if source_root else folder
    allowed = {'作品', '时区', '视频文件', '来源文件', '本次覆盖', '平台任务'}
    if not isinstance(specification, dict) or set(specification) - allowed:
        raise ValueError('输入只能包含作品、时区、视频文件、来源文件、本次覆盖、平台任务')
    validate_fields(specification)
    task = copy.deepcopy(specification)
    source_names = task['来源文件']
    if any(not isinstance(name, str) for name in source_names) or len(set(source_names)) != len(source_names):
        raise ValueError('输入来源文件须为不重复的相对路径列表')
    task.update({'格式版本': '1.1', '任务批次ID': str(uuid.uuid4()),
                 '生成时间': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds'),
                 '来源根目录': str(root), '视频SHA256': None})
    task['来源文件'] = [{'路径': name, 'SHA256': digest(within(root, name))} for name in source_names]
    if task['视频文件']:
        task['视频SHA256'] = digest(within(folder, task['视频文件']))
    incomplete = not task['视频文件']
    for item in task['平台任务']:
        item['封面SHA256'] = {role: digest(within(folder, file)) if file else None for role, file in item['封面'].items()}
        incomplete = incomplete or bool(item['待补充']) or not item['账号']['账号ID'] or not item['封面']['竖版']
        incomplete = incomplete or any(item[k] in [None, '', '无', '待补充'] for k in ['标题', '描述']) or item['话题'] is None
    task['状态'] = '待补充' if incomplete else '待预检'
    path = folder / NAME
    if path.is_file():
        old = json.loads(path.read_text())
        ignore = {'任务批次ID', '生成时间'}
        if {k: v for k, v in old.items() if k not in ignore} == {k: v for k, v in task.items() if k not in ignore}:
            return old
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(task, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)
    return task


def load(folder):
    folder = Path(folder).resolve()
    task = json.loads(within(folder, NAME).read_text())
    if task.get('格式版本') != '1.1' or task.get('时区') != 'Asia/Shanghai':
        raise ValueError('不支持的发布任务版本或时区')
    uuid.UUID(task['任务批次ID'])
    validate_fields(task)
    root = Path(task['来源根目录']).resolve()
    for source in task['来源文件']:
        if digest(within(root, source['路径'])) != source['SHA256']:
            raise ValueError('来源已变化，请重新生成发布任务：' + source['路径'])
    if not task.get('视频文件') or digest(within(folder, task['视频文件'])) != task.get('视频SHA256'):
        raise ValueError('视频缺失或已变化，请重新生成发布任务')
    items = task.get('平台任务')
    if not isinstance(items, list) or not items or len({i['平台'] for i in items}) != len(items):
        raise ValueError('平台任务须为非空、不重复列表')
    return task


def translate(folder, subset=None):
    task = load(folder)
    items = task['平台任务']
    selected = subset.split(',') if subset else [i['平台'] for i in items]
    reverse = {v: k for k, v in PLATFORMS.items()}
    selected = [reverse.get(p, p) for p in selected]
    if not selected or len(set(selected)) != len(selected) or any(p not in [i['平台'] for i in items] for p in selected):
        raise ValueError('执行范围只能缩小到任务中已选平台')
    content = {'type': 'VIDEO', 'video': task['视频文件'], 'overrides': {}}
    actions = {}
    problems = []
    for item in items:
        name = item['平台']
        if name not in selected:
            continue
        if name not in PLATFORMS:
            raise ValueError('未知平台：' + name)
        errors = list(item.get('待补充', []))
        for field in ['标题', '描述']:
            if item[field] in [None, '', '无', '待补充']:
                errors.append(field + '缺失')
        if item['话题'] is None:
            errors.append('话题意图缺失')
        if not isinstance(item.get('账号'), dict) or not item['账号'].get('账号ID'):
            errors.append('稳定账号ID缺失')
        if item.get('目标动作') not in ACTIONS:
            errors.append('目标动作无效')
        if type(item.get('定时发表')) is not bool or type(item.get('声明原创')) is not bool:
            errors.append('定时发表和声明原创须为布尔值')
        if item.get('定时发表') is not False or item.get('定时发表时间') is not None:
            errors.append('非零定时发表尚未接通')
        if item.get('合集') is not None:
            errors.append('指定合集尚未接通')
        if item.get('目标动作') == '存草稿' and name != '视频号':
            errors.append('该平台视频存草稿尚未接通')
        if name != '视频号' and item.get('声明原创') is True:
            errors.append('该平台原创开关设置尚未接通')
        covers = item.get('封面', {})
        if not covers.get('竖版'):
            errors.append('指定竖版封面缺失')
        if set(covers) != {'竖版', '横版'} or (name != '抖音' and covers.get('横版')):
            errors.append('当前平台封面字段不匹配')
        for role, file in covers.items():
            if file and digest(within(Path(folder).resolve(), file)) != item.get('封面SHA256', {}).get(role):
                errors.append(role + '封面已变化')
        if errors:
            problems.append(name + '：' + '、'.join(errors))
            continue
        key = PLATFORMS[name]
        actions[key] = ACTIONS[item['目标动作']]
        content['overrides'][key] = {'title': item['标题'], 'content': item['描述'], 'description': item['描述'],
            'tags': item['话题'], 'collectionId': None, 'scheduledPublishTime': 0, 'original': item['声明原创'],
            'expectedAccountId': item['账号']['账号ID'], 'cover': covers['竖版'], 'visibility': '公开'}
        if covers.get('横版'):
            content['overrides'][key]['horizontalCover'] = covers['横版']
    if problems:
        raise ValueError('预检未通过；未创建任务。' + '；'.join(problems))
    return task, content, {'VIDEO': list(actions), 'actions': actions}
