export class ScheduleError extends RangeError {
  readonly code: 'SCHEDULE_INVALID_TASK' | 'SCHEDULE_CYCLE';
  readonly taskIds: readonly string[];

  constructor(code: ScheduleError['code'], message: string, taskIds: readonly string[]) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    this.taskIds = taskIds;
  }
}
