require('dotenv').config();
const axios = require('axios');
const { chromium } = require('playwright');

const GUAP_LOGIN = process.env.GUAP_LOGIN;
const GUAP_PASSWORD = process.env.GUAP_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const PROFILE_URL = 'https://pro.guap.ru/inside/profile';
const TASKS_URL = 'https://pro.guap.ru/inside/student/tasks/';

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function parseDeadlineDate(text) {
  const match = String(text).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function getTodayMSK() {
  const now = new Date();
  const mskUtcTime = now.getTime() + 3 * 60 * 60 * 1000;
  const msk = new Date(mskUtcTime);
  return new Date(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
}

function formatDateDDMMYYYY(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}.${m}.${y}`;
}

function daysBetween(deadlineDate, todayMSK) {
  const utcDeadline = Date.UTC(
    deadlineDate.getFullYear(),
    deadlineDate.getMonth(),
    deadlineDate.getDate()
  );
  const utcToday = Date.UTC(
    todayMSK.getFullYear(),
    todayMSK.getMonth(),
    todayMSK.getDate()
  );
  return Math.round((utcDeadline - utcToday) / (24 * 60 * 60 * 1000));
}

async function sendTelegramMessage(text) {
  log('Отправка уведомления в Telegram...');
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const response = await axios.post(url, {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
  log(`Ответ Telegram API: HTTP ${response.status}`);
  return response.data;
}

async function main() {
  if (!GUAP_LOGIN || !GUAP_PASSWORD) {
    throw new Error(
      'Переменные окружения GUAP_LOGIN и/или GUAP_PASSWORD не заданы'
    );
  }
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    throw new Error(
      'Переменные окружения TG_BOT_TOKEN и/или TG_CHAT_ID не заданы'
    );
  }

  const tgTokenPreview = TG_BOT_TOKEN
    ? TG_BOT_TOKEN.substring(0, 8) + '...'
    : 'НЕ ЗАДАН';
  log(
    `Переменные окружения: GUAP_LOGIN=${GUAP_LOGIN}, TG_BOT_TOKEN=${tgTokenPreview}, TG_CHAT_ID=${TG_CHAT_ID ? 'задан' : 'НЕ ЗАДАН'}`
  );

  log('=== Старт скрипта парсинга дедлайнов ЛК ГУАП ===');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    log(`Открытие страницы профиля: ${PROFILE_URL}`);
    await page.goto(PROFILE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    try {
      await page.waitForURL('**/sso.guap.ru/**', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      log('Переход на страницу SSO авторизации выполнен');
    } catch (navError) {
      const currentUrl = page.url();
      log(
        `Ожидание редиректа на SSO истекло. Текущий URL: ${currentUrl}. Ошибка: ${navError.message}`
      );
      throw navError;
    }

    log('Ввод email...');
    const emailInput = page
      .locator('input#username, input[name="username"]')
      .first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(GUAP_LOGIN);
    log('Email введен');

    log('Ввод пароля...');
    const passwordInput = page
      .locator('input#password-input, input[name="password"]')
      .first();
    await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
    await passwordInput.fill(GUAP_PASSWORD);
    log('Пароль введен');

    log('Клик кнопки "Войти"...');
    const submitButton = page
      .locator(
        'input#kc-login, input[name="login"], .pf-c-button.pf-m-primary.pf-m-block.btn-lg'
      )
      .first();
    await submitButton.waitFor({ state: 'visible', timeout: 10000 });

    await submitButton.click();
    try {
      await page.waitForURL('**/inside/profile', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      log(
        'Переход на страницу профиля https://pro.guap.ru/inside/profile выполнен'
      );
    } catch (navError) {
      const currentUrl = page.url();
      log(
        `Ожидание перехода на /inside/profile истекло. Текущий URL: ${currentUrl}. Ошибка: ${navError.message}`
      );
      throw navError;
    }

    log(`Переход на страницу заданий: ${TASKS_URL}`);
    await page.goto(TASKS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    log('Страница заданий загружена');

    log('Начало парсинга заданий...');

    await page
      .locator('tr:has(a.blue-link)')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(() =>
        log(
          'Предупреждение: строки с задачами не найдены на странице'
        )
      );

    const rowHandles = await page
      .locator('tr:has(a.blue-link)')
      .elementHandles();
    log(`Найдено строк с задачами: ${rowHandles.length}`);

    const tasks = [];

    for (let i = 0; i < rowHandles.length; i++) {
      const handle = rowHandles[i];

      const taskData = await page.evaluate((el) => {
        const disciplineLink = el.querySelector('a.blue-link');
        if (!disciplineLink) return null;

        const discipline = disciplineLink.textContent.trim();

        const workLink = el.querySelector('a.link-switch-blue');
        const workTitle = workLink ? workLink.textContent.trim() : null;

        const deadlineSpan = el.querySelector(
          'span.text-warning, span.text-info'
        );
        let deadlineText = null;
        let mustUpload = false;
        let noDate = false;

        if (deadlineSpan) {
          deadlineText = deadlineSpan.textContent.trim();

          const isValidDate = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.test(
            deadlineText
          );

          if (!isValidDate) {
            deadlineText = 'Не указанана';
            noDate = true;
          } else {
            const parent = deadlineSpan.parentElement;
            if (parent && parent.querySelector('i.text-danger')) {
              mustUpload = true;
            } else {
              const nextSibling = deadlineSpan.nextElementSibling;
              if (
                nextSibling &&
                nextSibling.tagName === 'I' &&
                nextSibling.classList.contains('text-danger')
              ) {
                mustUpload = true;
              }
            }
          }
        } else {
          const td = el.querySelector('td.text-center');
          if (td && td.textContent.trim().includes('Не указан')) {
            deadlineText = 'Не указанана';
            noDate = true;
          }
        }

        return {
          discipline,
          workTitle,
          deadlineText,
          mustUpload,
          noDate,
        };
      }, handle);

      if (!taskData) {
        log(`Задача #${i + 1}: не disciplina, пропускаем`);
        continue;
      }

      log(
        `Задача #${i + 1}: дисциплина="${taskData.discipline}", работа="${taskData.workTitle}", дедлайн="${taskData.deadlineText}", mustUpload=${taskData.mustUpload}, noDate=${taskData.noDate}`
      );

      let deadlineDate = null;
      if (!taskData.noDate && taskData.deadlineText) {
        deadlineDate = parseDeadlineDate(taskData.deadlineText);
        if (!deadlineDate) {
          log(
            `Задача #${i + 1}: не удалось распарсить дату "${taskData.deadlineText}", пропускаем`
          );
          continue;
        }
      }

      tasks.push({
        discipline: taskData.discipline,
        workTitle: taskData.workTitle,
        deadlineText: taskData.deadlineText,
        deadlineDate,
        mustUpload: taskData.mustUpload,
        noDate: taskData.noDate,
      });
    }

    log(
      `Успешный парсинг завершен. Найдено задач: ${tasks.length}`
    );

    const todayMSK = getTodayMSK();
    log(`Текущая дата по МСК: ${formatDateDDMMYYYY(todayMSK)}`);

    let sentCount = 0;

    for (const task of tasks) {
      // Если дата null, считаем задачей без даты
      if (!task.deadlineDate) {
        task.noDate = true;
      }

      // Задания без даты — напоминаем 15 числа каждого месяца
      if (task.noDate) {
        const dayOfMonth = todayMSK.getDate();
        if (dayOfMonth !== 13) {
          log(
            `Пропуск задачи без даты "${task.workTitle}": сегодня ${dayOfMonth} число, напоминание только 15-го`
          );
          continue;
        }

        const message =
          '🚨 *Напоминание о дедлайне!*\n\n' +
          `📚 *${task.discipline}*\n` +
          `📝 ${task.workTitle}\n` +
          '⏳ Срок сдачи: до конца сессии';

        log(
          `Отправка напоминания (без даты): "${task.workTitle}" (${task.discipline}), 15 число месяца`
        );

        await sendTelegramMessage(message);
        sentCount++;
        continue;
      }

      const diffDays = daysBetween(task.deadlineDate, todayMSK);
      if (diffDays !== 7 && diffDays !== 3) {
        log(
          `Пропуск "${task.workTitle}" (${task.deadlineText}): до дедлайна ${diffDays} дней (не 7 и не 3)`
        );
        continue;
      }

      let reminderLabel = null;
      if (diffDays === 7) {
        reminderLabel = 'неделю';
      } else if (diffDays === 3) {
        reminderLabel = '3 дня';
      }

      const dateLabel = task.deadlineText;
      let message;

      if (task.mustUpload) {
        message =
          '🔥 *КРИТИЧЕСКИЙ ДЕДЛАЙН! ТРЕБУЕТСЯ ЗАГРУЗКА!*\n\n' +
          `📚 *${task.discipline}*\n` +
          `📝 ${task.workTitle}\n` +
          `⏳ Срок сдачи: через ${reminderLabel} (${dateLabel})\n` +
          '⚠️ *Внимание:* Эту работу необходимо обязательно загрузить в ЛК!';
      } else {
        message =
          '🚨 *Напоминание о дедлайне!*\n\n' +
          `📚 *${task.discipline}*\n` +
          `📝 ${task.workTitle}\n` +
          `⏳ Срок сдачи: через ${reminderLabel} (${dateLabel})`;
      }

      log(
        `Отправка напоминания: "${task.workTitle}" (${task.discipline}), через ${reminderLabel} (${dateLabel}), mustUpload=${task.mustUpload}`
      );

      await sendTelegramMessage(message);
      sentCount++;
    }

    log(`Отправлено напоминаний: ${sentCount}`);
    log('=== Скрипт завершен успешно ===');
  } catch (error) {
    log(`ОШИБКА выполнения скрипта: ${error.message}`);
    try {
      await page.screenshot({ path: 'error.png', fullPage: true });
      log('Скриншот ошибки сохранен: error.png');
    } catch (screenshotError) {
      log(
        `Не удалось сохранить скриншот ошибки: ${screenshotError.message}`
      );
    }
    throw error;
  } finally {
    await browser.close();
    log('Браузер закрыт');
  }
}

main().catch((error) => {
  console.error(`Фатальная ошибка: ${error.message}`);
  process.exit(1);
});
