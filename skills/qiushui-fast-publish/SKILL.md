---
name: qiushui-fast-publish
description: 读取已确定的发布文案和素材，通过FastPublish调用上游三平台视频脚本，填写后停留或自动发表。
---

# 秋水项目发布编排

读取当前项目的发布规范、作品发布文案和实际素材，形成发布任务.json，再通过Bun CLI交给FastPublish。使用用户选定的成品封面，不重新生成或截图。文件名以当前作品为准。

## 账号选择

所有内容类型在上传或填写前，先按 [账号选择](references/accounts.md) 从项目发布规范解析默认账号或本次指定的名称/别名、核对执行环境及实际登录身份。名称冲突、未配对目标浏览器或身份无法核实时，停止该平台并说明原因。只有用户明确要求更改以后默认值时，才更新发布规范。

## 视频流程

1. 按用户本次要求确定平台、标题、描述、话题、封面及目标动作。使用 references/publication.md 的JSON格式与 generate-video-task 生成任务。
2. `plan-video-task <作品目录> [--platforms 视频号,小红书]`检查输入能否转换为上游参数。
3. 设置 MULTIPOST_STATE_DIR 为已运行服务的私有状态目录，复用配对。使用 `connection` 确认连接及 videoTaskRevision>=46。
4. `run-video-task <作品目录> [--platforms 视频号,小红书] --timeout 900`直接调用上游视频handler。基于上游5522ca0，小红书封面使用修订49、抖音封面使用修订51的页面适配；配置了账号ID时先实时核对，失败停止上传；不额外做正文、话题、媒体状态、原创或定时一致性拦截。
5. “填完保持不动”传 isAutoPublish=false；“直接发布”传true。“存草稿”是旧输入兼容别名，现映射为填写后停留，明确告诉用户不会自动保存草稿。
6. 回执executed仅表示上游脚本返回，不能据此声称已保存草稿或发布成功。返回原编辑页及实际结果；后续发表由用户当前指令决定。

旧视频resume、独立publish、save-video-draft及草稿核对流程不再用于三平台视频。旧任务保留作历史记录，新模式使用独立批次任务键。不要恢复旧失败任务来运行新流程。

## 维护

通用执行器及CLI维护于FastPublish仓库，项目scripts和通用参考文档同步部署。业务默认规则读取当前项目。其他内容类型保持现有入口，见references/legacy.md。
