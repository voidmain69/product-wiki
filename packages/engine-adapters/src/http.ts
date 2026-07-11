import { Agent, interceptors, request, type Dispatcher } from "undici";

/**
 * Спільний undici-диспетчер з redirect-інтерцептором. У undici 6+ опція
 * `maxRedirections` на дефолтному агенті не підтримується — редиректи вмикаються
 * лише через інтерцептор. Тримаємо один агент на процес (пул з'єднань).
 */
// maxHeaderSize підняте: реальні сайти виробників (напр. Logitech) шлють великі
// набори cookie-заголовків, що перевищують дефолт undici 16KB → UND_ERR_HEADERS_OVERFLOW.
export const redirectDispatcher: Dispatcher = new Agent({ maxHeaderSize: 128 * 1024 }).compose(
  interceptors.redirect({ maxRedirections: 5 }),
);

/** GET із дотриманням редиректів і вказаним User-Agent. */
export function httpGet(url: string, userAgent: string, accept = "text/html,application/xhtml+xml") {
  return request(url, {
    method: "GET",
    headers: { "user-agent": userAgent, accept },
    dispatcher: redirectDispatcher,
  });
}
