import type { Page } from '@playwright/test';

export const todayPin = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit',
}).format(new Date()).replaceAll('-', '');

export async function fillPin(page: Page, pin: string): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await page.getByRole('textbox', { name: `PIN ${String(index + 1)}번째 숫자`, exact: true }).fill(pin[index] ?? '');
  }
}
