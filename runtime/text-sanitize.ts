const OSC_SEQUENCE = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const CSI_SEQUENCE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const FE_SEQUENCE = /\x1B[@-_]/g;
const C0_C1_CONTROLS = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;
const BIDI_AND_ZERO_WIDTH = /[​-‏‪-‮⁦-⁩﻿]/g;

export function truncateByCodepoint(text: string, maxLength: number): string {
  const codepoints = Array.from(text);
  return codepoints.length > maxLength ? codepoints.slice(0, maxLength).join("") : text;
}

export function sanitizeText(input: string, maxLength: number = Number.POSITIVE_INFINITY): string {
  // OSC 必须先于通用 ESC 清理处理：其终止符可以是 BEL（\x07），
  // 若先跑通用控制字符清理会把 BEL 提前吃掉，导致 OSC 序列的其余部分被当成普通文本保留
  const withoutOsc = input.replace(OSC_SEQUENCE, "");
  const withoutCsi = withoutOsc.replace(CSI_SEQUENCE, "");
  const withoutFe = withoutCsi.replace(FE_SEQUENCE, "");
  const withoutControls = withoutFe.replace(C0_C1_CONTROLS, "");
  const withoutBidi = withoutControls.replace(BIDI_AND_ZERO_WIDTH, "");
  // 按码点而非 UTF-16 code unit 截断，避免把代理对从中间切开
  return truncateByCodepoint(withoutBidi, maxLength);
}
