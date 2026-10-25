/**
 * Pure presentation projection of an internal task record.
 *
 * No IO, no globals, no mutation, no echo of untrusted input strings.
 */

const VALID_STATES = new Set([
  'capturing',
  'converting',
  'saving',
  'saved',
  'failed',
  'interrupted',
  'cancelled',
]);

/**
 * Build the fixed view model for a task record.
 *
 * @param {unknown} task internal task record (or null/undefined)
 * @returns {{headline: string, detail: string, tone: string, canCancel: boolean, canRetry: boolean, canNewCopy: boolean, canCheck: boolean} | null}
 */
export function taskView(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    return null;
  }

  // Own property only: never inherit a state from the prototype chain.
  if (!Object.prototype.hasOwnProperty.call(task, 'state')) {
    return null;
  }
  const state = task.state;
  if (typeof state !== 'string' || !VALID_STATES.has(state)) {
    return null;
  }

  const view = {
    headline: '',
    detail: '',
    tone: 'neutral',
    canCancel: false,
    canRetry: false,
    canNewCopy: false,
    canCheck: false,
  };

  switch (state) {
    case 'capturing':
      view.headline = '正在读取当前文件';
      view.detail = '关闭弹窗后可以重新查看进度。';
      view.tone = 'working';
      view.canCancel = true;
      break;
    case 'converting':
      view.headline = '正在转换本地文件';
      view.detail = '正在准备可编辑副本。';
      view.tone = 'working';
      view.canCancel = true;
      break;
    case 'saving':
      view.headline = '正在保存到本机';
      view.detail = '正在确认写入，此阶段请勿重复保存。';
      view.tone = 'working';
      view.canCheck = true;
      break;
    case 'saved':
      if (task.partial === true) {
        view.headline = '已保存，有内容需要核对';
        view.detail = '请在本地文件中查看采集检查结果。';
        view.tone = 'partial';
      } else {
        view.headline = '已保存到本机';
        view.detail = '来源覆盖与可编辑回导仍需分别核对。';
        view.tone = 'success';
      }
      view.canNewCopy = true;
      break;
    case 'failed':
      view.headline = '保存未完成';
      view.detail = '原文件未改动，可以重新读取。';
      view.tone = 'error';
      view.canRetry = true;
      break;
    case 'interrupted':
      if (task.stage === 'NATIVE') {
        view.headline = '保存结果尚未确认';
        view.detail = '先检查本次保存结果，避免重复副本。';
        view.tone = 'neutral';
        view.canCheck = true;
      } else {
        view.headline = '本次读取已中断';
        view.detail = '页面仍可读取时，可以重新开始。';
        view.tone = 'neutral';
        view.canRetry = true;
      }
      break;
    case 'cancelled':
      view.headline = '本次读取已停止';
      view.detail = '未交付新的本地副本。';
      view.tone = 'neutral';
      view.canRetry = true;
      break;
  }

  return view;
}

export default taskView;
