#!/usr/bin/env python3
"""Local content validation, one-use browser bridge and durable receipts."""
import argparse
import base64
import hashlib
import importlib.util
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[3]
STATE = Path(os.environ.get('MULTIPOST_STATE_DIR', str(ROOT / '.multipost-local'))).resolve()
ORIGIN = 'http://localhost:2663'
DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / 'config/platforms.yaml'
TERMINAL = {'account_verified', 'metrics_collected', 'filled', 'draft_saved', 'published', 'submitted_pending_review', 'needs_attention', 'failed', 'result_unconfirmed', 'unsupported', 'unverified'}
LOCK = threading.Lock()
VIDEO_PLATFORMS = {'VIDEO_WEIXINCHANNEL', 'VIDEO_REDNOTE', 'VIDEO_DOUYIN'}
TEXT_CANDIDATES = {'DYNAMIC_TOUTIAO', 'DYNAMIC_OKJIKE', 'DYNAMIC_ZSXQ', 'DYNAMIC_MAIMAI', 'DYNAMIC_X'}

_publication_spec = importlib.util.spec_from_file_location('publication', Path(__file__).with_name('publication.py'))
publication = importlib.util.module_from_spec(_publication_spec)
_publication_spec.loader.exec_module(publication)


def read_metadata(path):
    if path.suffix == '.json':
        return json.loads(path.read_text())
    try:
        import yaml
    except ImportError as exc:
        raise ValueError('读取 YAML 需要 PyYAML；请安装 scripts/requirements.txt 中的依赖，或使用 content.json。') from exc
    return yaml.safe_load(path.read_text())


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.chmod(0o600)
    temporary.replace(path)


def confined(folder, name):
    folder = Path(folder).resolve()
    if not isinstance(name, str) or not name:
        raise ValueError('素材路径必须是非空字符串')
    path = (folder / name).resolve()
    if not path.is_relative_to(folder) or not path.is_file():
        raise ValueError(f'文件不存在或越出内容目录：{name}')
    return path


def x_weighted_length(value):
    # X counts CJK and most non-Latin glyphs as two display units; URLs use a fixed allowance.
    chunks = re.split(r'(https?://\S+)', value)
    return sum(23 if re.fullmatch(r'https?://\S+', part) else sum(2 if ord(char) > 0x10ff else 1 for char in part)
               for part in chunks)


def preflight(folder, config, action, subset, chinese=False):
    folder = Path(folder).resolve()
    if chinese:
        _, content, chinese_config = publication.translate(folder, subset)
    else:
        metadata = next((folder / name for name in ['content.yaml', 'content.json'] if (folder / name).is_file()), None)
        if not metadata:
            raise ValueError('内容目录缺少 content.yaml 或 content.json')
        content = read_metadata(metadata)
    if not isinstance(content, dict):
        raise ValueError('内容元数据必须是对象')
    kind = content.get('type')
    if kind not in ['DYNAMIC', 'ARTICLE', 'VIDEO', 'PODCAST']:
        raise ValueError('type 必须为 DYNAMIC、ARTICLE、VIDEO 或 PODCAST')
    configuration = chinese_config if chinese else read_metadata(Path(config))
    if not isinstance(configuration, dict):
        raise ValueError('平台配置必须是按内容类型分组的对象')
    configured = configuration.get(kind, [])
    if not isinstance(configured, list) or not all(isinstance(item, str) for item in configured):
        raise ValueError('平台配置必须是平台键列表')
    platforms = subset.split(',') if subset else configured
    if not platforms or len(set(platforms)) != len(platforms) or any(item not in configured for item in platforms):
        raise ValueError('目标平台须为该类型已配置平台的非空、不重复子集')
    if len(platforms) != 1:
        raise ValueError('单任务只接受一个平台；多个平台请使用 plan-config 或 run-config')
    overrides = content.get('overrides', {})
    if not isinstance(overrides, dict) or any(key not in configured or not isinstance(value, dict) for key, value in overrides.items()):
        raise ValueError('overrides 只能包含已配置平台')
    if kind == 'DYNAMIC' and content.get('images', []) == [] and not content.get('videos'):
        platform = platforms[0]
        if platform not in TEXT_CANDIDATES or action != 'prepare':
            raise ValueError(f'{platform} 当前动态入口的纯文字准备未验证，不发送无图内容')
        effective = {**content, **overrides.get(platform, {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'targetSphere', 'overrides'}
        if unsupported or effective.get('type') != kind:
            raise ValueError('纯文字内容包含未适配字段或改变了内容类型')
        if effective.get('images', []) != [] or effective.get('videos'):
            raise ValueError('纯文字平台覆盖不能增加图片或视频')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        if not isinstance(body, str) or not body.strip():
            raise ValueError('纯文字正文不能为空')
        full_text = body.rstrip() + ('\n' + ' '.join(f'#{tag}' for tag in tags) if tags else '')
        limit = 280 if platform == 'DYNAMIC_X' else 10000 if platform == 'DYNAMIC_ZSXQ' else 1000
        if len(full_text) > limit:
            raise ValueError(f'{platform} 纯文字正文包含标签后最多 {limit} 字符')
        data = {'title': '', 'content': full_text, 'tags': [], 'images': [], 'videos': [], 'textOnly': True}
        if platform == 'DYNAMIC_ZSXQ':
            targets = configuration.get('targets', {})
            sphere = effective.get('targetSphere', targets.get('DYNAMIC_ZSXQ') if isinstance(targets, dict) else None)
            if not isinstance(sphere, str) or not sphere.strip():
                raise ValueError('知识星球纯文字必须指定 targetSphere')
            data['targetSphere'] = sphere.strip()
        elif 'targetSphere' in effective:
            raise ValueError('只有知识星球接受 targetSphere')
        return {'platform': platform, 'action': action, 'data': data}
    # Each platform/action is admitted only after its own input contract is checked.
    if kind == 'ARTICLE' and platforms == ['ARTICLE_WEIXIN']:
        if action != 'save_draft':
            raise ValueError('微信公众号文章当前仅开放 save_draft 测试；不降级目标动作')
        effective = {**content, **overrides.get('ARTICLE_WEIXIN', {})}
        unsupported = set(effective) - {'type', 'title', 'digest', 'htmlFile', 'cover', 'overrides'}
        if unsupported:
            raise ValueError('公众号文章尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        digest = effective.get('digest', '')
        if not isinstance(title, str) or not 1 <= len(title) <= 64:
            raise ValueError('公众号文章标题须为 1–64 个字符')
        if not isinstance(digest, str) or len(digest) > 120:
            raise ValueError('公众号文章摘要最多 120 个字符')
        html = confined(folder, effective.get('htmlFile')).read_text()
        if not html.strip() or '<script' in html.lower() or '<iframe' in html.lower():
            raise ValueError('文章 HTML 不能为空且不接受脚本或 iframe')
        cover = media_file(folder, effective.get('cover'))
        return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'digest': digest, 'htmlContent': html, 'markdownContent': '', 'cover': cover, 'images': []}}
    if kind == 'VIDEO' and platforms[0] in VIDEO_PLATFORMS:
        # Publishing always creates a linked task from the original filled editor.
        if action != 'prepare':
            raise ValueError('视频须先 prepare，再对已填写的原任务使用 publish；不直接提交内容目录')
        platform = platforms[0]
        effective = {**content, **overrides.get(platform, {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'video', 'cover', 'horizontalCover', 'verticalCover', 'expectedAccountId', 'visibility', 'overrides', 'tags', 'scheduledPublishTime', 'original', 'description', 'category', 'collectionId'}
        if unsupported or effective.get('type') != kind:
            raise ValueError('视频内容包含未适配字段或改变了内容类型：' + ', '.join(sorted(unsupported)))
        title = effective.get('title')
        body = confined(folder, effective['bodyFile']).read_text().rstrip() if 'bodyFile' in effective else effective.get('content', '')
        limit = {'VIDEO_REDNOTE': 20, 'VIDEO_DOUYIN': 30, 'VIDEO_WEIXINCHANNEL': 16}[platform]
        if not isinstance(title, str) or not title.strip() or len(title) > limit:
            raise ValueError(f'{platform} 标题须为 1–{limit} 字符')
        if platform == 'VIDEO_WEIXINCHANNEL' and any(not (c.isalnum() or c in ' 《》“”‘’\"\':：+＋?？%％℃') for c in title):
            raise ValueError('视频号短标题含不支持的符号；逗号请用空格代替，仅支持书名号、引号、冒号、加号、问号、百分号、摄氏度')
        if not isinstance(body, str) or not body.strip() or len(body) > 1000:
            raise ValueError('视频描述须为 1–1000 字符')
        account_id = effective.get('expectedAccountId')
        if account_id is not None and (not isinstance(account_id, str) or not re.fullmatch(r'[A-Za-z0-9_@.-]{1,200}', account_id)):
            raise ValueError('expectedAccountId 必须是已核对的平台稳定账号ID')
        if effective.get('visibility', '公开') != '公开':
            raise ValueError('当前视频任务只接受明确的公开可见性')
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or len(tags) > (5 if platform == 'VIDEO_DOUYIN' else 10) or len(set(str(tag) for tag in tags)) != len(tags) or not all(isinstance(tag, str) and tag.strip() == tag and 0 < len(tag) <= 40 and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('视频话题须为不重复的非空词列表，不包含#或换行；抖音最多5个')
        scheduled = effective.get('scheduledPublishTime', 0)
        if type(scheduled) is not int or scheduled != 0:
            raise ValueError('当前视频任务仅验证立即发布，scheduledPublishTime须明确为0')
        if 'original' in effective and type(effective['original']) is not bool:
            raise ValueError('original须为明确布尔值')
        if effective.get('category') is not None or effective.get('collectionId') is not None:
            raise ValueError('本三平台视频尚未适配分类或合集，请明确设为null或不提供')
        if effective.get('description', body) != body:
            raise ValueError('当前视频独立description须与正文一致，避免两份描述冲突')
        data = {'title': title, 'content': body, 'video': video_file(folder, effective.get('video')), 'tags': tags, 'visibility': '公开', 'scheduledPublishTime': scheduled}
        if 'original' in effective:
            data['original'] = effective['original']
        if 'description' in effective:
            data['description'] = body
        if account_id:
            data['expectedAccountId'] = account_id
        for field in ['cover', 'horizontalCover', 'verticalCover']:
            if effective.get(field) is not None:
                data[field] = media_file(folder, effective[field])
        if platform == 'VIDEO_REDNOTE' and 'horizontalCover' in data:
            raise ValueError('小红书视频当前使用单张 cover，不接受横封面字段')
        if platform != 'VIDEO_WEIXINCHANNEL' and 'verticalCover' in data:
            raise ValueError('小红书和抖音视频当前使用单张 cover，不接受竖封面字段')
        if 'cover' in data and 'verticalCover' in data:
            raise ValueError('cover 与 verticalCover 不能同时填写，避免封面选择歧义')
        return {'platform': platform, 'action': action, 'data': data}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_DOUYIN']:
        if action != 'prepare':
            raise ValueError('抖音动态图文当前仅开放 prepare；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_DOUYIN', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('抖音动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        if not isinstance(title, str) or not 1 <= len(title) <= 30:
            raise ValueError('抖音动态图文标题须为 1–30 个字符')
        suffix = ' ' + ' '.join(f'#{tag}' for tag in tags) if tags else ''
        if not isinstance(body, str) or not body.strip() or len(body + suffix) > 1000:
            raise ValueError('抖音动态图文描述包含标签后须为 1–1000 个字符')
        image_paths = effective.get('images', [])
        if not isinstance(image_paths, list) or not 1 <= len(image_paths) <= 9 or effective.get('videos'):
            raise ValueError('抖音动态图文须包含 1–9 张图片，不接受视频')
        images = [media_file(folder, name) for name in image_paths]
        return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'content': body, 'tags': tags, 'images': images, 'videos': []}}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_TOUTIAO']:
        if action != 'prepare':
            raise ValueError('今日头条动态图文当前仅开放 prepare；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_TOUTIAO', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('今日头条动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError('今日头条动态图文需要非空标题和正文')
        suffix = ' ' + ' '.join(f'#{tag}#' for tag in tags) if tags else ''
        if len(title + '\n\n' + body + suffix) > 1000:
            raise ValueError('今日头条动态图文合并标题、正文和标签后最多 1000 字符')
        image_paths = effective.get('images', [])
        if not isinstance(image_paths, list) or not 1 <= len(image_paths) <= 9 or effective.get('videos'):
            raise ValueError('今日头条动态图文须包含 1–9 张图片，不接受视频')
        images = [media_file(folder, name) for name in image_paths]
        return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'content': body, 'tags': tags, 'images': images, 'videos': []}}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_OKJIKE']:
        if action != 'prepare':
            raise ValueError('即刻动态图文当前仅开放 prepare；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_OKJIKE', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('即刻动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError('即刻动态图文需要非空标题和正文')
        suffix = ' ' + ' '.join(f'#{tag}' for tag in tags) if tags else ''
        if len(title + '\n' + body + suffix) > 1000:
            raise ValueError('即刻动态图文合并标题、正文和标签后最多 1000 字符')
        image_paths = effective.get('images', [])
        if not isinstance(image_paths, list) or not 1 <= len(image_paths) <= 9 or effective.get('videos'):
            raise ValueError('即刻动态图文须包含 1–9 张图片，不接受视频')
        images = [media_file(folder, name) for name in image_paths]
        return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'content': body, 'tags': tags, 'images': images, 'videos': []}}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_ZSXQ']:
        if action != 'prepare':
            raise ValueError('知识星球动态图文当前仅开放 prepare；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_ZSXQ', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'targetSphere', 'overrides'}
        if unsupported:
            raise ValueError('知识星球动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        targets = configuration.get('targets', {})
        if not isinstance(targets, dict):
            raise ValueError('平台目标配置 targets 必须是对象')
        sphere = effective.get('targetSphere', targets.get('DYNAMIC_ZSXQ'))
        tags = effective.get('tags', [])
        if not isinstance(sphere, str) or not sphere.strip():
            raise ValueError('知识星球动态图文必须指定 targetSphere')
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError('知识星球动态图文需要非空标题和正文')
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        images = effective.get('images', [])
        if not isinstance(images, list) or not 1 <= len(images) <= 9 or effective.get('videos'):
            raise ValueError('知识星球动态图文须包含 1–9 张图片，不接受视频')
        return {'platform': platforms[0], 'action': action, 'data': {
            'title': title, 'content': body, 'tags': tags,
            'images': [media_file(folder, name) for name in images], 'videos': [],
            'targetSphere': sphere.strip(),
        }}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_MAIMAI']:
        if action != 'prepare':
            raise ValueError('脉脉动态图文当前仅开放 prepare；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_MAIMAI', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('脉脉动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError('脉脉动态图文需要非空标题和正文')
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        images = effective.get('images', [])
        if not isinstance(images, list) or not 1 <= len(images) <= 9 or effective.get('videos'):
            raise ValueError('脉脉动态图文须包含 1–9 张图片，不接受视频')
        return {'platform': platforms[0], 'action': action, 'data': {
            'title': title, 'content': body, 'tags': tags,
            'images': [media_file(folder, name) for name in images], 'videos': [],
        }}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_X']:
        if action != 'prepare':
            raise ValueError('X 动态图文当前仅开放 prepare；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_X', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('X 动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError('X 动态图文需要非空标题和正文')
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        suffix = ' ' + ' '.join(f'#{tag}' for tag in tags) if tags else ''
        if x_weighted_length(title + '\n' + body + suffix) > 280:
            raise ValueError('X 动态图文合并标题、正文和标签后超过平台的 280 加权字符限制')
        images = effective.get('images', [])
        if not isinstance(images, list) or not 1 <= len(images) <= 4 or effective.get('videos'):
            raise ValueError('X 动态图文须包含 1–4 张图片，不接受视频')
        return {'platform': platforms[0], 'action': action, 'data': {
            'title': title, 'content': body, 'tags': tags,
            'images': [media_file(folder, name) for name in images], 'videos': [],
        }}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_WEIXINCHANNEL']:
        if action not in ['prepare', 'publish']:
            raise ValueError('微信视频号动态图文仅支持 prepare 或先填写核对再 publish；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_WEIXINCHANNEL', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('视频号动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        if not isinstance(title, str) or not 1 <= len(title) <= 22:
            raise ValueError('视频号动态图文标题须为 1–22 个字符')
        suffix = ' ' + ' '.join(f'#{tag}' for tag in tags) if tags else ''
        if not isinstance(body, str) or not body.strip() or len(body + suffix) > 1000:
            raise ValueError('视频号动态图文描述包含标签后须为 1–1000 个字符')
        image_paths = effective.get('images', [])
        if not isinstance(image_paths, list) or not 1 <= len(image_paths) <= 18 or effective.get('videos'):
            raise ValueError('视频号动态图文须包含 1–18 张图片，不接受视频')
        images = [media_file(folder, name) for name in image_paths]
        return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'content': body, 'tags': tags, 'images': images, 'videos': []}}
    if kind == 'DYNAMIC' and platforms == ['DYNAMIC_WEIXIN']:
        if action != 'save_draft':
            raise ValueError('微信公众号动态图文当前仅开放 save_draft；不降级目标动作')
        effective = {**content, **overrides.get('DYNAMIC_WEIXIN', {})}
        unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides'}
        if unsupported:
            raise ValueError('公众号动态图文尚未适配这些字段：' + ', '.join(sorted(unsupported)))
        if effective.get('type') != kind:
            raise ValueError('逐平台覆盖不能改变内容类型')
        title = effective.get('title')
        body = effective.get('content', '')
        if 'bodyFile' in effective:
            body = confined(folder, effective['bodyFile']).read_text().rstrip()
        tags = effective.get('tags', [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
            raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
        if not isinstance(title, str) or not 1 <= len(title) <= 64:
            raise ValueError('公众号动态图文标题须为 1–64 个字符')
        suffix = ' ' + ' '.join(f'#{tag}' for tag in tags) if tags else ''
        if not isinstance(body, str) or not body.strip() or len(body + suffix) > 1000:
            raise ValueError('公众号动态图文正文包含标签后须为 1–1000 个字符')
        image_paths = effective.get('images', [])
        if not isinstance(image_paths, list) or not 1 <= len(image_paths) <= 20 or effective.get('videos'):
            raise ValueError('公众号动态图文须包含 1–20 张图片，不接受视频')
        images = [media_file(folder, name) for name in image_paths]
        return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'content': body, 'tags': tags, 'images': images, 'videos': []}}
    if kind != 'DYNAMIC' or platforms != ['DYNAMIC_REDNOTE']:
        raise ValueError('首版执行适配仅开放 DYNAMIC / DYNAMIC_REDNOTE；其他类型或平台动作尚未验证')
    if action != 'prepare':
        raise ValueError('小红书自动暂存／直接发布尚未验证；首版仅执行 prepare，不降级目标动作')
    effective = {**content, **overrides.get('DYNAMIC_REDNOTE', {})}
    unsupported = set(effective) - {'type', 'title', 'content', 'bodyFile', 'tags', 'images', 'videos', 'overrides', 'expectedAccountId'}
    if unsupported:
        raise ValueError('首版尚未适配这些字段：' + ', '.join(sorted(unsupported)))
    if effective.get('type') != kind:
        raise ValueError('逐平台覆盖不能改变内容类型')
    title = effective.get('title', '')
    body = effective.get('content', '')
    if 'bodyFile' in effective:
        body = confined(folder, effective['bodyFile']).read_text().rstrip()
    tags = effective.get('tags', [])
    if not isinstance(title, str) or not 1 <= len(title) <= 20:
        raise ValueError('小红书标题须为 1–20 个字符')
    if not isinstance(tags, list) or not all(isinstance(tag, str) and tag and not any(c in tag for c in '#\n\r') for tag in tags):
        raise ValueError('tags 须为非空字符串列表，不包含 # 或换行')
    suffix = ' ' + ' '.join(f'#{tag}#' for tag in tags) if tags else ''
    if not isinstance(body, str) or not body.strip() or len(body + suffix) > 1000:
        raise ValueError('小红书正文须非空，包含标签文本后不超过 1000 字符')
    image_paths = effective.get('images', [])
    if not isinstance(image_paths, list) or not 1 <= len(image_paths) <= 18 or effective.get('videos'):
        raise ValueError('动态图文须包含 1–18 张图片，首版不接受视频')
    account_id = effective.get('expectedAccountId')
    if account_id is not None and (not isinstance(account_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', account_id)):
        raise ValueError('expectedAccountId 必须是已登记的平台稳定账号ID')
    images = [media_file(folder, name) for name in image_paths]
    return {'platform': platforms[0], 'action': action, 'data': {'title': title, 'content': body, 'tags': tags, 'images': images, 'videos': [], **({'expectedAccountId': account_id} if account_id else {})}}


def configured_plans(folder, config, subset, chinese=False):
    folder = Path(folder).resolve()
    if chinese:
        task, _, configuration = publication.translate(folder, subset)
        plans = []
        for platform, target_action in configuration['actions'].items():
            plan = preflight(folder, config, 'prepare', platform, chinese=True)
            plan['action'] = target_action
            plan['inputFormat'] = 'publication'
            plan['idempotencyKey'] = str(uuid.uuid5(uuid.UUID(task['任务批次ID']), platform))
            plans.append(plan)
        return plans

    metadata = next((folder / name for name in ['content.yaml', 'content.json'] if (folder / name).is_file()), None)
    if not metadata:
        raise ValueError('内容目录缺少 content.yaml 或 content.json')
    content = read_metadata(metadata)
    if not isinstance(content, dict):
        raise ValueError('内容元数据必须是对象')
    configuration = read_metadata(Path(config))
    if not isinstance(configuration, dict):
        raise ValueError('平台配置必须是按内容类型分组的对象')
    configured = configuration.get(content.get('type'), [])
    selected = subset.split(',') if subset else configured
    if not isinstance(configured, list) or not configured or not selected or len(set(selected)) != len(selected) or any(platform not in configured for platform in selected):
        raise ValueError('目标平台须为该类型已配置平台的非空、不重复子集')
    actions = configuration.get('actions', {})
    if not isinstance(actions, dict):
        raise ValueError('平台目标动作配置必须为对象')
    if content.get('type') == 'DYNAMIC' and content.get('images', []) == [] and not content.get('videos'):
        verified = configuration.get('textVerified', [])
        if not isinstance(verified, list) or any(platform not in TEXT_CANDIDATES for platform in verified):
            raise ValueError('textVerified 只能包含已适配的纯文字候选平台')
        selected = [platform for platform in selected if platform in verified]
        if not selected:
            reasons = text_skips(folder, config, subset)
            raise ValueError('没有经本机插件真实验证的纯文字目标平台；不发送。跳过原因：' +
                             '；'.join(f'{item["platform"]}: {item["reason"]}' for item in reasons))
    return [preflight(folder, config, actions.get(platform, 'prepare'), platform) for platform in selected]


def text_skips(folder, config, subset):
    folder = Path(folder).resolve()
    metadata = next((folder / name for name in ['content.yaml', 'content.json'] if (folder / name).is_file()), None)
    if not metadata:
        return []
    content = read_metadata(metadata)
    if content.get('type') != 'DYNAMIC' or content.get('images', []) != [] or content.get('videos'):
        return []
    configuration = read_metadata(Path(config))
    selected = subset.split(',') if subset else configuration.get('DYNAMIC', [])
    verified = configuration.get('textVerified', [])
    reasons = {
        'DYNAMIC_REDNOTE': '当前小红书图文入口要求图片',
        'DYNAMIC_WEIXIN': '当前公众号图文草稿入口要求图片；文字群发属于另一流程',
        'DYNAMIC_WEIXINCHANNEL': '当前视频号图文入口要求图片，纯文字未验证',
        'DYNAMIC_DOUYIN': '当前抖音图文入口要求图片，纯文字未验证',
    }
    return [{'platform': platform, 'status': 'skipped', 'reason': reasons.get(platform, '当前动态入口尚无插件纯文字填写回执')} for platform in selected if platform not in verified]


def media_file(folder, name):
    path = confined(folder, name)
    raw = path.read_bytes()
    mime = mimetypes.guess_type(path.name)[0]
    if mime not in ['image/png', 'image/jpeg', 'image/webp'] or not 0 < len(raw) <= 32 * 1024 * 1024:
        raise ValueError(f'图片格式或大小不合要求：{name}')
    valid = (mime == 'image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n')) or (mime == 'image/jpeg' and raw.startswith(b'\xff\xd8\xff')) or (mime == 'image/webp' and raw[:4] == b'RIFF' and raw[8:12] == b'WEBP')
    if not valid:
        raise ValueError(f'图片内容与后缀不一致：{name}')
    return {'name': path.name, 'path': str(path), 'type': mime, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def video_file(folder, name):
    path = confined(folder, name)
    raw = path.read_bytes()
    if path.suffix.lower() != '.mp4' or not 0 < len(raw) <= 100 * 1024 * 1024 or b'ftyp' not in raw[:32]:
        raise ValueError('视频任务须为 100 MiB 内的有效 MP4')
    return {'name': path.name, 'path': str(path), 'type': 'video/mp4', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def task_path(task_id):
    return STATE / 'tasks' / f'{uuid.UUID(task_id)}.json'


def public(task):
    return {key: task[key] for key in ['taskId', 'platform', 'action', 'createdAt', 'updatedAt', 'receipt']}


def load_task(path):
    task = json.loads(path.read_text())
    execution_limit = 900 if task.get('platform') in VIDEO_PLATFORMS else 180 if task.get('platform') == 'DYNAMIC_OKJIKE' else 120
    if task['receipt']['status'] in ['claimed', 'running'] and time.time() - task['updatedAt'] > execution_limit:
        task['receipt'] = {**task['receipt'], 'status': 'result_unconfirmed', 'code': 'EXECUTOR_INTERRUPTED', 'message': '超过执行时限仍无回执，请先核查原任务和页面，不自动重发。'}
        task['updatedAt'] = time.time()
        atomic(path, task)
    return task


def bridge_url(task):
    return f'{ORIGIN}/bridge#{task["taskId"]}:{task["claimToken"]}'


def claim_task(task):
    if task.get('operation') in ['publish', 'reconcile', 'collect', 'account', 'save_draft', 'reconcile_draft', 'repair_draft_title', 'inspect_drafts', 'inspect_draft_editor']:
        task['claimed'] = True
        task['receipt'] = {**task['receipt'], 'status': 'claimed'}
        task['updatedAt'] = time.time()
        atomic(task_path(task['taskId']), task)
        return {key: task[key] for key in ['taskId', 'platform', 'action', 'callbackToken', 'operation', 'data', 'sourceTaskId', 'sourceTabId', 'preparedEvidence', 'readbackPath'] if key in task}
    previous_receipt = task['receipt'].copy()
    data = {**task['data'], 'images': []}
    if task.get('replaceExisting'):
        data['replaceExisting'] = task['replaceExisting']
    materials = [(None, image) for image in task['data'].get('images', [])] + [(field, task['data'][field]) for field in ['cover', 'horizontalCover', 'verticalCover', 'video'] if field in task['data']]
    for field, image in materials:
        raw = Path(image['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != image['sha256']:
            raise ValueError(f'素材在预检后发生变化：{image["name"]}')
        packed = {key: image[key] for key in ['name', 'type', 'size', 'sha256']}
        packed['url'] = f'data:{image["type"]};base64,' + base64.b64encode(raw).decode()
        if field:
            data[field] = packed
        else:
            data['images'].append(packed)
    task['claimed'] = True
    task['receipt'] = {**task['receipt'], 'status': 'claimed'}
    task['updatedAt'] = time.time()
    atomic(task_path(task['taskId']), task)
    return {key: task[key] for key in ['taskId', 'platform', 'action', 'callbackToken', 'operation', 'videoStep'] if key in task} | {'data': data, 'previousReceipt': previous_receipt}


def executor_status():
    path = STATE / 'executor.json'
    if not path.exists():
        return {'paired': False, 'online': False, 'code': 'PAIRING_REQUIRED'}
    executor = json.loads(path.read_text())
    return {'paired': True, 'extensionId': executor['extensionId'], 'online': time.time() - executor.get('lastSeen', 0) < 75, 'lastSeen': executor.get('lastSeen'), 'videoTaskProtocol': executor.get('videoTaskProtocol'), 'videoTaskRevision': executor.get('videoTaskRevision')}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # URLs and credentials do not belong in logs.

    def reply(self, code, data, mime='application/json'):
        raw = json.dumps(data, ensure_ascii=False).encode() if mime == 'application/json' else data.encode()
        if code == 204:
            raw = b''
        self.send_response(code)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def admin(self):
        if self.headers.get('Authorization') != f'Bearer {self.server.api_token}':
            raise ValueError('本机 CLI 凭证无效')

    def gate(self):
        if self.headers.get('Host') not in ['localhost:2663', '127.0.0.1:2663']:
            raise ValueError('仅接受本机请求')
        origin = self.headers.get('Origin', '')
        if origin and origin != ORIGIN and not origin.startswith('chrome-extension://'):
            raise ValueError('请求来源无效')

    def do_GET(self):
        try:
            self.gate()
            parsed = urlparse(self.path)
            if parsed.path == '/bridge':
                page = (Path(__file__).parent / 'bridge.html').read_text()
                return self.reply(200, page, 'text/html')
            if parsed.path == '/pair':
                return self.reply(200, (Path(__file__).parent / 'pair.html').read_text(), 'text/html')
            if parsed.path == '/health':
                return self.reply(200, {'ready': True, 'protocol': 2})
            if parsed.path == '/connection':
                self.admin()
                return self.reply(200, executor_status())
            if parsed.path == '/next':
                with LOCK:
                    executor = json.loads((STATE / 'executor.json').read_text())
                    if self.headers.get('Authorization') != f'Bearer {executor["token"]}' or self.headers.get('X-MultiPost-Extension-Id') != executor['extensionId']:
                        raise ValueError('插件执行器凭证无效')
                    origin = self.headers.get('Origin', '')
                    if origin and origin != 'chrome-extension://' + executor['extensionId']:
                        raise ValueError('插件执行器来源不一致')
                    executor['videoTaskProtocol'] = 1 if self.headers.get('X-FastPublish-Video-Tasks') == '1' else None
                    revision = self.headers.get('X-FastPublish-Video-Revision', '')
                    executor['videoTaskRevision'] = int(revision) if re.fullmatch(r'[1-9][0-9]{0,2}', revision) else None
                    executor['lastSeen'] = time.time()
                    atomic(STATE / 'executor.json', executor)
                    tasks = [load_task(path) for path in (STATE / 'tasks').glob('*.json')]
                    if any(task['receipt']['status'] in ['claimed', 'running'] for task in tasks):
                        return self.reply(204, {})
                    queued = sorted((task for task in tasks if task.get('delivery') == 'automatic' and task['receipt']['status'] == 'queued' and not task['claimed']), key=lambda task: task['createdAt'])
                    if not queued:
                        return self.reply(204, {})
                    task = queued[0]
                    try:
                        return self.reply(200, claim_task(task))
                    except (ValueError, OSError) as exc:
                        task['receipt'] = {'status': 'failed', 'code': 'MATERIAL_CHANGED', 'message': str(exc)}
                        task['updatedAt'] = time.time()
                        atomic(task_path(task['taskId']), task)
                        return self.reply(204, {})
            if parsed.path == '/status':
                query = parse_qs(parsed.query)
                with LOCK:
                    task = load_task(task_path(query['taskId'][0]))
                token = query.get('token', [''])[0]
                if not secrets.compare_digest(token, task['claimToken']):
                    self.admin()
                return self.reply(200, public(task))
            self.reply(404, {'error': 'NOT_FOUND'})
        except (ValueError, KeyError, OSError) as exc:
            self.reply(400, {'error': str(exc)})

    def do_POST(self):
        try:
            self.gate()
            length = int(self.headers.get('Content-Length', '0'))
            if length > 1024 * 1024:
                raise ValueError('请求过大')
            body = json.loads(self.rfile.read(length))
            with LOCK:
                if self.path == '/pairing':
                    self.admin()
                    pairing = {'token': secrets.token_urlsafe(32), 'expiresAt': time.time() + 300, 'used': False}
                    atomic(STATE / 'pairing.json', pairing)
                    return self.reply(200, {'pairingUrl': ORIGIN + '/pair#' + pairing['token'], 'expiresInSeconds': 300})
                if self.path == '/pair-claim':
                    pairing = json.loads((STATE / 'pairing.json').read_text())
                    extension_id = body.get('extensionId', '')
                    origin = self.headers.get('Origin', '')
                    if not re.fullmatch('[a-p]{32}', extension_id) or (origin and origin != 'chrome-extension://' + extension_id):
                        raise ValueError('插件身份无效')
                    if pairing['used'] or time.time() > pairing['expiresAt'] or not secrets.compare_digest(str(body.get('token', '')), pairing['token']):
                        raise ValueError('配对凭证已使用、过期或无效')
                    token = secrets.token_urlsafe(32)
                    atomic(STATE / 'executor.json', {'token': token, 'extensionId': extension_id, 'lastSeen': 0})
                    pairing['used'] = True
                    atomic(STATE / 'pairing.json', pairing)
                    return self.reply(200, {'executorToken': token})
                if self.path == '/submit':
                    self.admin()
                    plan = preflight(body['folder'], body.get('config', str(DEFAULT_CONFIG)), body.get('action', 'prepare'), body.get('platforms'), chinese=body.get('inputFormat') == 'publication')
                    if plan['platform'] in VIDEO_PLATFORMS and executor_status().get('videoTaskProtocol') != 1:
                        raise ValueError('当前已配对插件尚未报告视频任务能力，请加载本次开发版并等待心跳')
                    if plan['platform'] in VIDEO_PLATFORMS and not plan['data'].get('expectedAccountId'):
                        raise ValueError('真实视频准备任务需要先核对 expectedAccountId；离线检查请使用 plan')
                    if plan['action'] == 'publish':
                        raise ValueError('直接发布须由 run 或 run-config 先创建已填写任务，再关联 publish 任务')
                    # A caller can persist this key before dispatch, then safely recover a lost response.
                    task_id = str(uuid.UUID(body['idempotencyKey'])) if body.get('idempotencyKey') else str(uuid.uuid4())
                    if task_path(task_id).exists():
                        previous = load_task(task_path(task_id))
                        if any(previous.get(key) != plan[key] for key in ['platform', 'action', 'data']):
                            raise ValueError('幂等键已用于不同内容，保留原任务核查')
                        return self.reply(200, public(previous))
                    task = {**plan, 'taskId': task_id, 'createdAt': time.time(), 'updatedAt': time.time(), 'claimToken': secrets.token_urlsafe(32), 'callbackToken': secrets.token_urlsafe(32), 'claimed': False, 'delivery': 'automatic', 'operation': 'start', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    atomic(task_path(task_id), task)
                    return self.reply(200, public(task))
                if self.path == '/metrics':
                    self.admin()
                    note_id = body.get('noteId', '')
                    account_id = body.get('expectedAccountId', '')
                    if not re.fullmatch(r'[a-fA-F0-9]{24}', note_id) or not re.fullmatch(r'[a-fA-F0-9]{24}', account_id):
                        raise ValueError('既有作品数据回收需要真实作品ID和目标账号ID')
                    task_id = str(uuid.uuid4())
                    task = {'taskId': task_id, 'platform': 'DYNAMIC_REDNOTE', 'action': 'collect',
                            'data': {'title': '', 'content': '', 'images': [], 'videos': [], 'noteId': note_id, 'expectedAccountId': account_id},
                            'operation': 'collect', 'createdAt': time.time(), 'updatedAt': time.time(),
                            'claimToken': secrets.token_urlsafe(32), 'callbackToken': secrets.token_urlsafe(32),
                            'claimed': False, 'delivery': 'automatic', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    atomic(task_path(task_id), task)
                    return self.reply(200, public(task))
                if self.path == '/account':
                    self.admin()
                    if body.get('platform') not in {'DYNAMIC_REDNOTE'} | VIDEO_PLATFORMS:
                        raise ValueError('账号实时核对仅支持已接通的平台')
                    task_id = str(uuid.uuid4())
                    task = {'taskId': task_id, 'platform': body['platform'], 'action': 'account',
                            'data': {'title': '', 'content': '', 'images': [], 'videos': []},
                            'operation': 'account', 'createdAt': time.time(), 'updatedAt': time.time(),
                            'claimToken': secrets.token_urlsafe(32), 'callbackToken': secrets.token_urlsafe(32),
                            'claimed': False, 'delivery': 'automatic', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    atomic(task_path(task_id), task)
                    return self.reply(200, public(task))
                if self.path == '/collect':
                    self.admin()
                    source = load_task(task_path(body['taskId']))
                    note_id = source['receipt'].get('evidence', {}).get('noteId', '')
                    if source['platform'] != 'DYNAMIC_REDNOTE' or source['receipt']['status'] != 'published' or not re.fullmatch(r'[a-fA-F0-9]{24}', note_id):
                        raise ValueError('数据回收需要已确认发布的小红书原任务和作品ID')
                    task_id = str(uuid.UUID(body['idempotencyKey'])) if body.get('idempotencyKey') else str(uuid.uuid4())
                    if task_path(task_id).exists():
                        previous = load_task(task_path(task_id))
                        if previous.get('operation') != 'collect' or previous.get('sourceTaskId') != source['taskId']:
                            raise ValueError('幂等键对应其他任务')
                        return self.reply(200, public(previous))
                    task = {'taskId': task_id, 'platform': source['platform'], 'action': 'collect',
                            'data': {**source['data'], 'images': [], 'noteId': note_id}, 'sourceTaskId': source['taskId'],
                            'operation': 'collect', 'createdAt': time.time(), 'updatedAt': time.time(),
                            'claimToken': secrets.token_urlsafe(32), 'callbackToken': secrets.token_urlsafe(32),
                            'claimed': False, 'delivery': 'automatic', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    atomic(task_path(task_id), task)
                    return self.reply(200, public(task))
                if self.path == '/save-video-draft':
                    self.admin()
                    source = load_task(task_path(body['taskId']))
                    if source['platform'] != 'VIDEO_WEIXINCHANNEL' or source['action'] != 'prepare':
                        raise ValueError('仅视频号已填写的原视频准备任务支持保存草稿')
                    if not source['data'].get('expectedAccountId') or source['receipt']['status'] != 'filled' or not isinstance(source['receipt'].get('tabId'), int):
                        raise ValueError('保存前必须核实账号、完整填写与原页面')
                    if source.get('publishTaskId'):
                        raise ValueError('原任务已有公开提交意图，先核对发表任务')
                    task_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'fastpublish-video-draft:' + source['taskId']))
                    if task_path(task_id).exists():
                        previous = load_task(task_path(task_id))
                        if previous.get('sourceTaskId') != source['taskId'] or previous.get('action') != 'save_draft':
                            raise ValueError('原视频草稿任务身份不匹配')
                        if body.get('retryAfterTitleRepair') is True:
                            if previous['receipt'].get('code') != 'TITLE_REPAIRED_READY' or previous['receipt']['status'] != 'needs_attention':
                                raise ValueError('仅已确认短标题被拒绝并完成修复的草稿任务可重新保存')
                            previous.setdefault('attemptHistory', []).append(previous['receipt'])
                            previous.update(operation='save_draft', claimed=False, delivery='automatic',
                                            claimToken=secrets.token_urlsafe(32), callbackToken=secrets.token_urlsafe(32),
                                            expiresAt=time.time() + 900, updatedAt=time.time(), receipt={'status': 'queued'})
                            atomic(task_path(task_id), previous)
                        return self.reply(200, public(previous))
                    if (executor_status().get('videoTaskRevision') or 0) < 22:
                        raise ValueError('已配对插件尚未报告视频草稿任务能力')
                    task = {'taskId': task_id, 'platform': source['platform'], 'action': 'save_draft', 'data': source['data'],
                            'sourceTaskId': source['taskId'], 'sourceTabId': source['receipt']['tabId'],
                            'preparedEvidence': source['receipt'].get('evidence', {}),
                            'createdAt': time.time(), 'updatedAt': time.time(), 'claimToken': secrets.token_urlsafe(32),
                            'callbackToken': secrets.token_urlsafe(32), 'claimed': False, 'delivery': 'automatic',
                            'operation': 'save_draft', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    atomic(task_path(task_id), task)
                    source['draftTaskId'] = task_id
                    atomic(task_path(source['taskId']), source)
                    return self.reply(200, public(task))
                if self.path == '/inspect-video-drafts':
                    self.admin()
                    source = load_task(task_path(body['taskId']))
                    if source['platform'] == 'VIDEO_WEIXINCHANNEL' and source['action'] == 'save_draft' and source['receipt']['status'] == 'draft_saved':
                        return self.reply(200, public(source))
                    if source['platform'] != 'VIDEO_WEIXINCHANNEL' or source['action'] != 'save_draft' or source['receipt']['status'] != 'result_unconfirmed' or not source.get('sourceTaskId'):
                        raise ValueError('仅已尝试保存且结果未知的视频号草稿任务支持独立草稿读回')
                    if (executor_status().get('videoTaskRevision') or 0) < 27:
                        raise ValueError('插件尚未报告独立草稿读回能力')
                    view = body.get('view', 'manager')
                    if view not in ['manager', 'editor', 'draft_manager']:
                        raise ValueError('草稿读回只支持管理页或全新编辑页')
                    task_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'fastpublish-video-draft-inspection:' + source['taskId'] + (':' + view if view != 'manager' else '')))
                    if task_path(task_id).exists():
                        return self.reply(200, public(load_task(task_path(task_id))))
                    task = {'taskId': task_id, 'platform': source['platform'], 'action': 'save_draft', 'data': source['data'],
                            'sourceTaskId': source['sourceTaskId'], 'draftSourceTaskId': source['taskId'],
                            'preparedEvidence': source.get('preparedEvidence', {}),
                            'createdAt': time.time(), 'updatedAt': time.time(), 'claimToken': secrets.token_urlsafe(32),
                            'callbackToken': secrets.token_urlsafe(32), 'claimed': False, 'delivery': 'automatic',
                            'operation': 'inspect_draft_editor' if view in ['editor', 'draft_manager'] else 'inspect_drafts', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    if view == 'draft_manager':
                        task['readbackPath'] = '/platform/post/draftListManager'
                    atomic(task_path(task_id), task)
                    return self.reply(200, public(task))
                if self.path == '/repair-video-draft-title':
                    self.admin()
                    task = load_task(task_path(body['taskId']))
                    evidence = task['receipt'].get('evidence', {})
                    old_title = task['data'].get('title', '')
                    invalid_title = len(old_title) > 16 or any(not (c.isalnum() or c in ' 《》“”‘’\"\':：+＋?？%％℃') for c in old_title)
                    observed_rejection = task['receipt']['status'] == 'needs_attention' and task['receipt'].get('code') == 'DRAFT_TITLE_REJECTED' and evidence.get('draftTitleRejected') is True
                    reported_rejection = body.get('userConfirmedTitleRejection') is True and invalid_title and task['receipt']['status'] == 'result_unconfirmed' and evidence.get('draftClickAttempted') is True
                    observed_repair_pause = task['receipt'].get('code') == 'TITLE_REPAIR_NOT_ADMITTED' and task.get('preparedEvidence', {}).get('draftTitleRejected') is True and isinstance(evidence.get('observedTitle'), str)
                    if task['platform'] != 'VIDEO_WEIXINCHANNEL' or task['action'] != 'save_draft' or not (observed_rejection or reported_rejection or observed_repair_pause):
                        raise ValueError('仅平台已明确拒绝短标题的原草稿任务可修复标题')
                    plan = preflight(body['folder'], body.get('config', str(DEFAULT_CONFIG)), 'prepare', task['platform'])
                    if {k: v for k, v in plan['data'].items() if k != 'title'} != {k: v for k, v in task['data'].items() if k != 'title'} or (plan['data']['title'] == task['data']['title'] and not observed_repair_pause):
                        raise ValueError('短标题修复仅允许改标题，视频、封面、正文与账号须保持一致')
                    task.setdefault('attemptHistory', []).append(task['receipt'])
                    task.setdefault('titleCorrections', []).append({'at': time.time(), 'previousTitle': old_title, 'title': plan['data']['title'], 'rejectionSource': 'platform_observation' if observed_rejection else 'explicit_user_report'})
                    task['preparedEvidence'] = {**task['preparedEvidence'], 'previousTitle': evidence['observedTitle'] if observed_repair_pause else task['data']['title'], 'draftTitleRejected': True}
                    task['data'] = plan['data']
                    task.update(operation='repair_draft_title', claimed=False, delivery='automatic',
                                claimToken=secrets.token_urlsafe(32), callbackToken=secrets.token_urlsafe(32),
                                expiresAt=time.time() + 900, updatedAt=time.time(), receipt={'status': 'queued'})
                    atomic(task_path(task['taskId']), task)
                    return self.reply(200, public(task))
                if self.path == '/reconcile-video-draft':
                    self.admin()
                    task = load_task(task_path(body['taskId']))
                    if task['platform'] != 'VIDEO_WEIXINCHANNEL' or task['action'] != 'save_draft' or not task.get('sourceTaskId'):
                        raise ValueError('仅视频号原草稿任务支持只读核对')
                    if task['receipt']['status'] == 'draft_saved':
                        return self.reply(200, public(task))
                    failed_readback = task['receipt']['status'] == 'failed' and task.get('operation') in ['inspect_drafts', 'inspect_draft_editor', 'reconcile_draft']
                    if task['receipt']['status'] != 'result_unconfirmed' and not failed_readback:
                        raise ValueError('仅结果未知的原草稿任务或失败的只读任务支持只读核对')
                    task.update(claimToken=secrets.token_urlsafe(32), callbackToken=secrets.token_urlsafe(32),
                                claimed=False, delivery='automatic', operation='reconcile_draft',
                                expiresAt=time.time() + 900, updatedAt=time.time(),
                                receipt={**task['receipt'], 'status': 'queued'})
                    atomic(task_path(task['taskId']), task)
                    return self.reply(200, public(task))
                if self.path == '/publish':
                    self.admin()
                    source = load_task(task_path(body['taskId']))
                    if source['platform'] not in [*VIDEO_PLATFORMS, 'DYNAMIC_REDNOTE', 'DYNAMIC_WEIXIN', 'DYNAMIC_WEIXINCHANNEL', 'DYNAMIC_DOUYIN', 'DYNAMIC_TOUTIAO', 'DYNAMIC_OKJIKE', 'DYNAMIC_ZSXQ', 'DYNAMIC_MAIMAI', 'DYNAMIC_X']:
                        raise ValueError('仅支持已接通的图文或视频原任务公开发布')
                    if source['platform'] in VIDEO_PLATFORMS and executor_status().get('videoTaskProtocol') != 1:
                        raise ValueError('当前已配对插件尚未报告视频任务能力')
                    if source['platform'] in VIDEO_PLATFORMS and not source['data'].get('expectedAccountId'):
                        raise ValueError('视频公开提交前必须提供已核对的 expectedAccountId')
                    if source['receipt']['status'] not in ['filled', 'draft_saved']:
                        raise ValueError('原任务尚未取得已填写或草稿已确认回执')
                    if not isinstance(source['receipt'].get('tabId'), int):
                        raise ValueError('原任务标签页不存在，不能安全发布')
                    if source.get('publishTaskId'):
                        return self.reply(200, public(load_task(task_path(source['publishTaskId']))))
                    task_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'fastpublish-video-publish:' + source['taskId'])) if source['platform'] in VIDEO_PLATFORMS else str(uuid.uuid4())
                    # Recover the task even if the server stopped between writing
                    # it and linking it on the prepared source.
                    if source['platform'] in VIDEO_PLATFORMS and task_path(task_id).exists():
                        previous = load_task(task_path(task_id))
                        if previous.get('sourceTaskId') != source['taskId'] or previous.get('action') != 'publish':
                            raise ValueError('原视频发表任务身份不匹配')
                        source['publishTaskId'] = task_id
                        atomic(task_path(source['taskId']), source)
                        return self.reply(200, public(previous))
                    task = {'taskId': task_id, 'platform': source['platform'], 'action': 'publish', 'data': source['data'],
                            'sourceTaskId': source['taskId'], 'sourceTabId': source['receipt']['tabId'],
                            'preparedEvidence': source['receipt'].get('evidence', {}),
                            'createdAt': time.time(), 'updatedAt': time.time(), 'claimToken': secrets.token_urlsafe(32),
                            'callbackToken': secrets.token_urlsafe(32), 'claimed': False, 'delivery': 'automatic',
                            'operation': 'publish', 'expiresAt': time.time() + 900, 'receipt': {'status': 'queued'}}
                    atomic(task_path(task_id), task)
                    source['publishTaskId'] = task_id
                    atomic(task_path(source['taskId']), source)
                    return self.reply(200, public(task))
                task = load_task(task_path(body['taskId']))
                if self.path == '/publish-resume':
                    self.admin()
                    if task.get('operation') != 'publish' or task['action'] != 'publish':
                        raise ValueError('仅能恢复原公开发布任务')
                    before_click = task['receipt']['status'] == 'needs_attention' and task['receipt'].get('code') in ['PUBLISH_CONTROL_NOT_READY', 'PREPARED_CONTENT_CHANGED', 'PREPARED_MEDIA_CHANGED', 'ACCOUNT_MISMATCH', 'ACCOUNT_UNVERIFIED', 'VISIBILITY_UNVERIFIED']
                    evidence = task['receipt'].get('evidence', {})
                    proven_rednote_host_noop = (
                        body.get('repairRednoteHostNoop') is True and task['platform'] == 'DYNAMIC_REDNOTE' and
                        task['receipt']['status'] == 'result_unconfirmed' and
                        task['receipt'].get('code') == 'PUBLISH_RESULT_NOT_CONFIRMED' and
                        evidence.get('buttonText') == '' and
                        str(evidence.get('customPublishControl', '')).startswith('<xhs-publish-btn ') and
                        evidence.get('url') == 'https://creator.xiaohongshu.com/publish/publish?target=image'
                    )
                    if not before_click and not proven_rednote_host_noop:
                        raise ValueError('仅点击前暂停或已证实的旧版小红书 host 空点击可恢复；其他未知结果禁止重试')
                    task.update(claimToken=secrets.token_urlsafe(32), callbackToken=secrets.token_urlsafe(32),
                                claimed=False, delivery='automatic', expiresAt=time.time() + 900,
                                updatedAt=time.time(), receipt={**task['receipt'], 'status': 'queued'})
                    atomic(task_path(task['taskId']), task)
                    return self.reply(200, public(task))
                if self.path == '/reconcile':
                    self.admin()
                    safe_bridge_failure = task['receipt']['status'] == 'failed' and task['receipt'].get('code') == 'INVALID_PUBLISH_SOURCE' and task.get('operation') == 'reconcile'
                    if task['action'] != 'publish' or (task['receipt']['status'] not in ['result_unconfirmed', 'submitted_pending_review'] and not safe_bridge_failure):
                        raise ValueError('仅公开发布结果未确认或待审核的原任务支持只读核查')
                    task.update(claimToken=secrets.token_urlsafe(32), callbackToken=secrets.token_urlsafe(32),
                                claimed=False, delivery='automatic', operation='reconcile',
                                expiresAt=time.time() + 900, updatedAt=time.time(),
                                receipt={**task['receipt'], 'status': 'queued'})
                    atomic(task_path(task['taskId']), task)
                    return self.reply(200, public(task))
                if self.path == '/resume':
                    self.admin()
                    if body.get('omitUnsupportedHorizontalCover') is True:
                        evidence = task['receipt'].get('evidence', {})
                        if task['platform'] != 'VIDEO_WEIXINCHANNEL' or task['action'] != 'prepare' or task['receipt']['status'] != 'needs_attention' or evidence.get('videoUploadStarted') is not True or task.get('publishTaskId') or task.get('draftTaskId'):
                            raise ValueError('仅已暂停、未提交的原视频号准备任务可适配单封面')
                        nodes = evidence.get('coverNodes', [])
                        if not any('个人主页和分享卡片(3:4)' in node.get('text', '') for node in nodes) or any('horizon' in node.get('className', '') for node in nodes):
                            raise ValueError('缺少当前单封面界面证据')
                        plan = preflight(body['folder'], body.get('config', str(DEFAULT_CONFIG)), 'prepare', task['platform'])
                        if plan['data'].get('horizontalCover') or {k: v for k, v in task['data'].items() if k != 'horizontalCover'} != plan['data']:
                            raise ValueError('单封面适配仅允许移除横封面；其余材料和账号必须保持一致')
                        previous_cover = task['data'].pop('horizontalCover', None)
                        if previous_cover:
                            task.setdefault('coverChanges', []).append({'at': time.time(), 'field': 'horizontalCover', 'previous': previous_cover, 'reason': '当前视频号仅有个人主页和分享卡片3:4封面入口；本轮按单封面执行草稿测试'})
                    if body.get('addHorizontalCover') is True:
                        if task['platform'] != 'VIDEO_DOUYIN' or task['action'] != 'prepare' or task['receipt']['status'] not in ['needs_attention', 'result_unconfirmed'] or task['receipt'].get('evidence', {}).get('videoUploadStarted') is not True:
                            raise ValueError('只允许给已暂停的原抖音视频准备任务追加横封面')
                        plan = preflight(body['folder'], body.get('config', str(DEFAULT_CONFIG)), 'prepare', task['platform'])
                        if {k: v for k, v in plan['data'].items() if k != 'horizontalCover'} != {k: v for k, v in task['data'].items() if k != 'horizontalCover'}:
                            raise ValueError('仅可追加横封面；视频、正文、标题、竖封面和账号必须保持一致')
                        horizontal = plan['data'].get('horizontalCover')
                        if not horizontal or (task['data'].get('horizontalCover') and task['data']['horizontalCover'] != horizontal):
                            raise ValueError('横封面缺失，或已绑定了另一份横封面')
                        if 'horizontalCover' not in task['data']:
                            task.setdefault('coverChanges', []).append({'at': time.time(), 'field': 'horizontalCover', 'file': horizontal, 'reason': '用户要求分别使用已生成的B横竖封面'})
                            task['data']['horizontalCover'] = horizontal
                    video_step = body.get('videoStep')
                    if video_step is not None:
                        if video_step not in ['open_cover', 'finish_cover', 'open_horizontal_cover', 'upload_cover', 'upload_horizontal_cover', 'inspect_fields'] or task['platform'] not in {'open_cover': ['VIDEO_REDNOTE'], 'finish_cover': ['VIDEO_REDNOTE', 'VIDEO_DOUYIN'], 'open_horizontal_cover': ['VIDEO_DOUYIN'], 'upload_cover': ['VIDEO_REDNOTE'], 'upload_horizontal_cover': ['VIDEO_DOUYIN'], 'inspect_fields': ['VIDEO_REDNOTE', 'VIDEO_DOUYIN']}.get(video_step, []) or task['action'] != 'prepare' or task['receipt']['status'] not in (['needs_attention', 'result_unconfirmed', 'filled'] if video_step == 'inspect_fields' else ['needs_attention', 'result_unconfirmed']):
                            raise ValueError('封面修复只允许对应平台已暂停的原视频准备任务；不接受存草稿或发布步骤')
                        if video_step != 'inspect_fields' and task['receipt'].get('evidence', {}).get('videoUploadStarted') is not True:
                            raise ValueError('原任务尚无视频上传意图证据')
                        task['videoStep'] = video_step
                        if video_step == 'inspect_fields' and task['receipt']['status'] == 'filled':
                            task.setdefault('inspectionHistory', []).append(task['receipt'].copy())
                            task['receipt'] = {**task['receipt'], 'status': 'needs_attention'}
                    else:
                        task.pop('videoStep', None)
                    source_id = body.get('replaceFrom')
                    if source_id:
                        if task['platform'] not in ['DYNAMIC_TOUTIAO', 'DYNAMIC_ZSXQ'] or task['action'] != 'prepare':
                            raise ValueError('仅头条和知识星球的动态图文准备任务支持核对后替换')
                        if task['receipt']['status'] not in ['needs_attention', 'result_unconfirmed']:
                            raise ValueError('当前任务状态不允许替换')
                        source = load_task(task_path(source_id))
                        if source['taskId'] == task['taskId'] or source['platform'] != task['platform'] or source['action'] != 'prepare' or source['receipt']['status'] != 'filled':
                            raise ValueError('来源必须为同平台已核实填写的独立准备任务')
                        old_images = source['data'].get('images', [])
                        new_images = task['data'].get('images', [])
                        text_without_old_images = task['platform'] in ['DYNAMIC_ZSXQ', 'DYNAMIC_TOUTIAO'] and task['data'].get('textOnly') and not new_images
                        old_text_to_new_images = task['platform'] in ['DYNAMIC_ZSXQ', 'DYNAMIC_TOUTIAO'] and source['data'].get('textOnly') and not old_images and bool(new_images)
                        if not text_without_old_images and not old_text_to_new_images and (
                            not old_images or [image['sha256'] for image in old_images] != [image['sha256'] for image in new_images]
                        ):
                            raise ValueError('新旧任务图片须逐一相同；或严格核对来源为无图纯文字任务后上传新图')
                        if task['platform'] == 'DYNAMIC_ZSXQ' and source['data'].get('targetSphere') != task['data'].get('targetSphere'):
                            raise ValueError('新旧任务目标星球不同')
                        task['replaceExisting'] = {'sourceTaskId': source['taskId'], 'title': source['data']['title'], 'content': source['data']['content'], 'tags': source['data'].get('tags', []), 'imageCount': len(old_images)}
                    else:
                        task.pop('replaceExisting', None)
                    if task['platform'] in ['ARTICLE_WEIXIN', 'DYNAMIC_WEIXIN']:
                        raise ValueError('公众号草稿创建可能已经成功，请在原任务或草稿箱核查；当前不自动恢复创建')
                    if task['platform'] in VIDEO_PLATFORMS and task.get('action') != 'prepare':
                        raise ValueError('视频仅准备任务支持 resume；发表结果未知请 reconcile')
                    if task['receipt']['status'] == 'filled':
                        raise ValueError('任务已核对完成，无需重新执行')
                    if task['receipt']['status'] in ['claimed', 'running'] and time.time() - task['updatedAt'] < 120:
                        raise ValueError('任务仍在执行，先查询结果')
                    if task['receipt']['status'] == 'queued':
                        raise ValueError('任务仍在排队，先查询结果，不重复恢复')
                    task.update(claimToken=secrets.token_urlsafe(32), callbackToken=secrets.token_urlsafe(32), claimed=False, delivery='automatic', operation='resume', expiresAt=time.time() + 900, receipt={**task['receipt'], 'status': 'queued'})
                    atomic(task_path(task['taskId']), task)
                    return self.reply(200, public(task))
                if self.path == '/claim':
                    if not secrets.compare_digest(str(body.get('token', '')), task['claimToken']) or task['claimed'] or time.time() > task['expiresAt']:
                        raise ValueError('任务凭证已使用、过期或无效；请查询原任务')
                    for path in (STATE / 'tasks').glob('*.json'):
                        other = load_task(path)
                        if other['taskId'] != task['taskId'] and other['receipt']['status'] in ['claimed', 'running']:
                            raise ValueError('当前有任务占用执行链路，请先完成或核查原任务')
                    return self.reply(200, claim_task(task))
                if self.path == '/result':
                    if not secrets.compare_digest(str(body.get('token', '')), task['callbackToken']):
                        raise ValueError('结果回传凭证无效')
                    receipt = body['receipt']
                    if receipt.get('taskId') != task['taskId'] or receipt.get('platform') != task['platform'] or receipt.get('action') != task['action'] or receipt.get('status') not in TERMINAL | {'running'}:
                        raise ValueError('结果与原任务不一致')
                    task['receipt'] = receipt
                    if task.get('operation') in ['inspect_drafts', 'inspect_draft_editor'] and isinstance(receipt.get('tabId'), int):
                        task['sourceTabId'] = receipt['tabId']
                    if task.get('draftSourceTaskId') and receipt.get('status') == 'draft_saved':
                        original = load_task(task_path(task['draftSourceTaskId']))
                        original.setdefault('readbackHistory', []).append(receipt)
                        original['receipt'] = {**original['receipt'], 'status': 'draft_saved', 'code': 'DRAFT_READBACK_CONFIRMED',
                                               'evidence': {**original['receipt'].get('evidence', {}), **receipt.get('evidence', {}),
                                                            'draftReadbackTaskId': task['taskId'], 'draftReadbackTabId': receipt.get('tabId')}}
                        original['updatedAt'] = time.time()
                        atomic(task_path(original['taskId']), original)
                    if task.get('operation') == 'repair_draft_title' and receipt.get('code') == 'TITLE_REPAIRED_READY':
                        source = load_task(task_path(task['sourceTaskId']))
                        source.setdefault('preparationHistory', []).append({'data': source['data'], 'receipt': source['receipt']})
                        source['data'] = task['data']
                        source['receipt'] = {**receipt, 'taskId': source['taskId'], 'action': 'prepare', 'status': 'filled', 'code': 'VIDEO_FIELDS_VERIFIED'}
                        source['updatedAt'] = time.time()
                        task['preparedEvidence'] = receipt.get('evidence', {})
                        atomic(task_path(source['taskId']), source)
                    task['updatedAt'] = time.time()
                    atomic(task_path(task['taskId']), task)
                    return self.reply(200, {'saved': True})
                self.reply(404, {'error': 'NOT_FOUND'})
        except (ValueError, KeyError, OSError) as exc:
            self.reply(400, {'error': str(exc)})


def request(path, body=None):
    info = json.loads((STATE / 'server.json').read_text())
    req = Request(ORIGIN + path, data=json.dumps(body).encode() if body is not None else None, headers={'Authorization': f'Bearer {info["token"]}', 'Content-Type': 'application/json'})
    with build_opener(ProxyHandler({})).open(req, timeout=15) as response:
        return json.load(response)


def wait_for_terminal(result, timeout):
    deadline = time.time() + timeout
    while result['receipt']['status'] not in TERMINAL and time.time() < deadline:
        time.sleep(1)
        result = request('/status?taskId=' + result['taskId'])
    return result


def execute_plan(folder, config, plan, timeout):
    # A public post must use the same prepared tab and content. Never submit a
    # publish action as a fresh fill task, which could duplicate the post.
    linked_draft = plan['platform'] in VIDEO_PLATFORMS and plan['action'] == 'save_draft'
    preparation_action = 'prepare' if plan['action'] == 'publish' or linked_draft else plan['action']
    body = {'folder': str(folder), 'config': str(config), 'action': preparation_action, 'platforms': plan['platform']}
    if plan.get('inputFormat'):
        body['inputFormat'] = plan['inputFormat']
    if plan.get('idempotencyKey'):
        body['idempotencyKey'] = plan['idempotencyKey']
    result = request('/submit', body)
    print(json.dumps({'taskId': result['taskId'], 'platform': plan['platform'],
                      'action': preparation_action, 'status': 'queued'}, ensure_ascii=False), flush=True)
    result = wait_for_terminal(result, timeout)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if (plan['action'] != 'publish' and not linked_draft) or result['receipt']['status'] != 'filled':
        return result
    try:
        published = request('/save-video-draft' if linked_draft else '/publish', {'taskId': result['taskId']})
    except HTTPError as exc:
        # Preparation is terminal here, so later platforms can proceed. Keep
        # the original task ID for inspection; no new fill or click is retried.
        print(json.dumps({'taskId': result['taskId'], 'platform': plan['platform'],
                          'action': plan['action'], 'status': 'needs_attention',
                          'code': 'FINAL_ACTION_NOT_STARTED', 'httpStatus': exc.code}, ensure_ascii=False), flush=True)
        return {**result, 'receipt': {'status': 'needs_attention', 'code': 'FINAL_ACTION_NOT_STARTED',
                                      'sourceStatus': result['receipt']['status']}}
    print(json.dumps({'taskId': published['taskId'], 'sourceTaskId': result['taskId'],
                      'platform': plan['platform'], 'action': plan['action'], 'status': published['receipt']['status']},
                     ensure_ascii=False), flush=True)
    published = wait_for_terminal(published, timeout)
    print(json.dumps(published, ensure_ascii=False), flush=True)
    return published


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('serve')
    sub.add_parser('pair')
    sub.add_parser('connection')
    for name in ['generate-video-task', 'plan-video-task', 'run-video-task']:
        command = sub.add_parser(name)
        command.add_argument('folder')
        if name == 'generate-video-task':
            command.add_argument('--input', required=True, help='明确任务参数JSON路径；-表示标准输入')
            command.add_argument('--source-root', help='来源文件的根目录；默认作品目录')
        else:
            command.add_argument('--platforms', help='中文平台名或VIDEO平台键，逗号分隔')
        if name == 'run-video-task':
            command.add_argument('--timeout', type=int, default=900)
            command.add_argument('--allow-publish', action='store_true')
    account = sub.add_parser('account')
    account.add_argument('--platform', choices=sorted(VIDEO_PLATFORMS | {'DYNAMIC_REDNOTE'}), required=True)
    account.add_argument('--timeout', type=int, default=90)
    for name in ['plan', 'submit', 'run', 'plan-config', 'run-config']:
        command = sub.add_parser(name)
        command.add_argument('folder')
        command.add_argument('--config', default=str(DEFAULT_CONFIG))
        if name in ['plan', 'submit', 'run']:
            command.add_argument('--action', choices=['prepare', 'save_draft', 'publish'], default='prepare')
        command.add_argument('--platforms')
        if name in ['run', 'run-config']:
            command.add_argument('--timeout', type=int, default=130)
    for name in ['status', 'resume', 'wait', 'publish', 'publish-resume', 'reconcile', 'save-video-draft', 'reconcile-video-draft', 'inspect-video-drafts']:
        command = sub.add_parser(name)
        command.add_argument('task_id')
        if name == 'resume':
            command.add_argument('--replace-from')
        if name == 'wait':
            command.add_argument('--timeout', type=int, default=100)
        if name in ['publish', 'publish-resume', 'reconcile', 'save-video-draft', 'reconcile-video-draft', 'inspect-video-drafts']:
            command.add_argument('--timeout', type=int, default=130)
        if name == 'publish-resume':
            command.add_argument('--repair-rednote-host-noop', action='store_true')
        if name == 'save-video-draft':
            command.add_argument('--retry-after-title-repair', action='store_true')
        if name == 'inspect-video-drafts':
            command.add_argument('--view', choices=['manager', 'editor', 'draft_manager'], default='draft_manager')
    args = parser.parse_args()
    try:
        if args.command == 'generate-video-task':
            specification = json.load(sys.stdin) if args.input == '-' else read_metadata(Path(args.input))
            task = publication.generate(args.folder, specification, args.source_root)
            print(json.dumps({'file': str(Path(args.folder).resolve() / publication.NAME),
                'batchId': task['任务批次ID'], 'status': task['状态'],
                'platforms': [item['平台'] for item in task['平台任务']]}, ensure_ascii=False, indent=2))
        elif args.command in ['plan-video-task', 'run-video-task']:
            plans = configured_plans(args.folder, DEFAULT_CONFIG, args.platforms, chinese=True)
            if args.command == 'plan-video-task':
                print(json.dumps([{'platform': p['platform'], 'action': p['action'], 'status': 'preflight_passed'} for p in plans], ensure_ascii=False, indent=2))
                return 0
            if any(p['action'] == 'publish' for p in plans) and not args.allow_publish:
                raise ValueError('本次含直接发布，须有用户明确授权并使用--allow-publish')
            if not request('/connection').get('online'):
                raise ValueError('插件执行器离线或未配对')
            snapshot = publication.load(args.folder)
            archived = STATE / 'publication-batches' / (snapshot['任务批次ID'] + '.json')
            if archived.exists() and json.loads(archived.read_text()) != snapshot:
                raise ValueError('同一批次的输入已改变，请重新生成任务')
            atomic(archived, snapshot)
            for plan in plans:
                result = execute_plan(args.folder, DEFAULT_CONFIG, plan, args.timeout)
                expected = {'prepare': 'filled', 'save_draft': 'draft_saved', 'publish': 'published'}[plan['action']]
                if result['receipt']['status'] != expected:
                    return 2
            return 0
        elif args.command == 'serve':
            server = ThreadingHTTPServer(('127.0.0.1', 2663), Handler)
            server.api_token = secrets.token_urlsafe(32)
            STATE.mkdir(mode=0o700, exist_ok=True)
            STATE.chmod(0o700)
            atomic(STATE / 'server.json', {'origin': ORIGIN, 'token': server.api_token})
            print(f'MultiPost 本机任务 API 已启动：{ORIGIN}', flush=True)
            server.serve_forever()
        elif args.command == 'pair':
            print(json.dumps(request('/pairing', {}), ensure_ascii=False, indent=2))
        elif args.command == 'account':
            task = request('/account', {'platform': args.platform})
            print(json.dumps(wait_for_terminal(task, args.timeout), ensure_ascii=False, indent=2))
        elif args.command == 'connection':
            print(json.dumps(request('/connection'), ensure_ascii=False, indent=2))
        elif args.command == 'plan':
            plan = preflight(args.folder, args.config, args.action, args.platforms)
            print(json.dumps({'platform': plan['platform'], 'action': plan['action'], 'title': plan['data']['title'], 'imageCount': len(plan['data'].get('images', [])) + int('cover' in plan['data']), 'hasVideo': 'video' in plan['data'], 'status': 'preflight_passed'}, ensure_ascii=False, indent=2))
        elif args.command == 'plan-config':
            plans = configured_plans(args.folder, args.config, args.platforms)
            planned = [{'platform': plan['platform'], 'action': plan['action'], 'title': plan['data']['title'], 'imageCount': len(plan['data'].get('images', [])) + int('cover' in plan['data']), 'status': 'preflight_passed'} for plan in plans]
            skipped = text_skips(args.folder, args.config, args.platforms)
            print(json.dumps({'planned': planned, 'skipped': skipped} if skipped else planned, ensure_ascii=False, indent=2))
        elif args.command == 'run-config':
            plans = configured_plans(args.folder, args.config, args.platforms)
            skipped = text_skips(args.folder, args.config, args.platforms)
            if skipped:
                print(json.dumps({'skipped': skipped}, ensure_ascii=False), flush=True)
            if not request('/connection').get('online'):
                raise ValueError('插件执行器离线或未配对；请打开已配对的浏览器并等待连接')
            results = []
            for plan in plans:
                result = execute_plan(args.folder, args.config, plan, args.timeout)
                results.append(result)
                if result['receipt']['status'] not in TERMINAL:
                    break  # Keep the in-flight task intact; never overlap or resend it.
            success = lambda plan, result: result and result['receipt']['status'] == {
                'prepare': 'filled', 'save_draft': 'draft_saved', 'publish': 'published',
            }[plan['action']]
            return 0 if len(results) == len(plans) and all(success(plan, result) for plan, result in zip(plans, results)) else 2
        elif args.command in ['submit', 'run']:
            # Validate locally even when the bridge is offline.
            plan = preflight(args.folder, args.config, args.action, args.platforms)
            if args.command == 'submit' and args.action == 'publish':
                raise ValueError('直接发布须使用 run，让 Skill 先填写核对再关联 publish 任务')
            if args.command == 'run' and not request('/connection').get('online'):
                raise ValueError('插件执行器离线或未配对；请打开已配对的浏览器并等待连接，不需要 Agent 操作页面')
            if args.command == 'submit':
                result = request('/submit', vars(args))
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                result = execute_plan(args.folder, args.config, plan, args.timeout)
                return 0 if result['receipt']['status'] == {
                    'prepare': 'filled', 'save_draft': 'draft_saved', 'publish': 'published',
                }[args.action] else 2
        elif args.command == 'resume':
            print(json.dumps(request('/resume', {'taskId': args.task_id, 'replaceFrom': args.replace_from}), ensure_ascii=False, indent=2))
        elif args.command in ['publish', 'publish-resume', 'reconcile', 'save-video-draft', 'reconcile-video-draft', 'inspect-video-drafts']:
            endpoint = {'publish': '/publish', 'publish-resume': '/publish-resume', 'reconcile': '/reconcile', 'save-video-draft': '/save-video-draft', 'reconcile-video-draft': '/reconcile-video-draft', 'inspect-video-drafts': '/inspect-video-drafts'}[args.command]
            body = {'taskId': args.task_id, 'repairRednoteHostNoop': getattr(args, 'repair_rednote_host_noop', False)}
            if args.command == 'inspect-video-drafts':
                body['view'] = args.view
            if getattr(args, 'retry_after_title_repair', False):
                body['retryAfterTitleRepair'] = True
            result = request(endpoint, body)
            print(json.dumps({'taskId': result['taskId'], 'platform': result['platform'], 'status': result['receipt']['status']}, ensure_ascii=False), flush=True)
            deadline = time.time() + args.timeout
            while result['receipt']['status'] not in TERMINAL and time.time() < deadline:
                time.sleep(1)
                result = request('/status?taskId=' + result['taskId'])
            print(json.dumps(result, ensure_ascii=False, indent=2))
            expected = 'draft_saved' if args.command in ['save-video-draft', 'reconcile-video-draft', 'inspect-video-drafts'] else 'published'
            return 0 if result['receipt']['status'] == expected else 2
        else:
            deadline = time.time() + (args.timeout if args.command == 'wait' else 0)
            while True:
                result = request('/status?taskId=' + str(uuid.UUID(args.task_id)))
                if args.command == 'status' or result['receipt']['status'] in TERMINAL or time.time() >= deadline:
                    print(json.dumps(result, ensure_ascii=False, indent=2))
                    return 0 if result['receipt']['status'] == 'filled' or args.command == 'status' else 2
                time.sleep(1)
        return 0
    except HTTPError as exc:
        print(exc.read().decode())
        return 2
    except (ValueError, KeyError, TypeError, OSError, URLError) as exc:
        print(json.dumps({'status': 'preflight_failed' if args.command in ['plan', 'submit', 'run', 'plan-config', 'run-config', 'plan-video-task', 'run-video-task'] else 'error', 'error': str(exc)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
