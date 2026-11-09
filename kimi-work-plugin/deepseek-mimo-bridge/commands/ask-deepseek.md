---
name: ask-deepseek
description: 把当前问题或材料转给 DeepSeek，拿回完整回答（单次调用，不与其他模型共答）
---

把下面内容整理成完整 prompt，交给 `ask_deepseek`（默认 `deepseek-flash`，effort=high；复杂任务用 `deepseek-v4-pro`）。拿到回答后按插件规则转述并标注来源，不要把你自己先写好的结论塞给它「确认」。

用户要问 DeepSeek 的内容：

$ARGUMENTS
