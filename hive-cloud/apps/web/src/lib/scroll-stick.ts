export const STICK_THRESHOLD_PX = 120;

export function shouldStickToBottom(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  thresholdPx?: number;
}): boolean {
  const threshold = args.thresholdPx ?? STICK_THRESHOLD_PX;
  return args.scrollHeight - args.scrollTop - args.clientHeight <= threshold;
}
