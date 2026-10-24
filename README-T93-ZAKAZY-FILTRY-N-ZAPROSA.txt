ЗАДАЧА T93
----------
Три улучшения страницы «Заказы по договорам»:
1) <div class="filter-panel"> (контейнер фильтров) стал сворачиваемым блоком
   фильтров — та же логика, что на «Запросах на коммерческие предложения»:
   шапка <div class="filters-header"> («Фильтры» слева, кнопка-треугольник
   ▲/▼ справа), состояние в localStorage (переживает перезагрузку);
2) в таблицы «Позиции заказа к договору» и «Доступные позиции плана»
   добавлена колонка «№ запроса»;
3) в filter-panel добавлен фильтр «№ запроса» для таблицы «Список заказов».

ПРИЧИНА / ЛОГИКА
----------------
1) Ранее filter-panel был плоским контейнером — единая сворачиваемая схема
   (t73: filters-collapse.js) обрабатывала только .filter-section. Т.к.
   .filter-panel есть ТОЛЬКО на orders.html, модуль расширен селектором
   '.filter-section, .filter-panel' — на другие страницы влияния нет.
2, 3) Связь заказа/позиции с запросом КП: poz_zakaz_dogovora -> plan ->
   kp.id_zaprosa_kp -> zapros_kp.n_zaprosa. Для позиций поле добавлено в
   SQL синтетических таблиц; для списка заказов фильтр работает через
   EXISTS: заказ показывается, если ХОТЯ БЫ ОДНА его позиция привязана к КП
   этого запроса. Поиск — GLOB с кириллицей/гомоглифами (как у остальных
   фильтров, cyrGlobPattern).

ЧТО СДЕЛАНО
-----------
public/js/common/filters-collapse.js (LF):
- селектор '.filter-section' -> '.filter-section, .filter-panel' (guard T93).
public/style.css (CRLF):
- правило .filters-block.collapsed .filter-panel { display: none; } —
  при сворачивании панель скрыта целиком, шапка остаётся.
public/pages/orders.html (CRLF):
- в filter-panel новый filter-item «№ запроса» (input fltNomerZaprosa).
public/js/modules/orders.js (CRLF):
- filterFields таблицы заказов: fltNomerZaprosa -> dbField n_zaprosa;
- applyZakazFilters(): fltNomerZaprosa читается из DOM (✅ T93-b);
- массивы слушателей и кнопки «Х» очищения: + fltNomerZaprosa;
- pozCols / availCols: колонка { key: 'n_zaprosa', label: '№ запроса' }.
src/routes/orderRoutes.js (CRLF):
- GET /api/orders читает query-параметр n_zaprosa и передаёт в запрос.
src/routes/helpers/syntheticTables.js (LF):
- orders.zakazy: buildWhere + EXISTS (pz -> plan -> kp -> zapros_kp, GLOB);
- orders.positions: + поле zk.n_zaprosa и JOIN zapros_kp;
- orders.available: + поле zk.n_zaprosa и JOIN zapros_kp.

ФАЙЛЫ
-----
public/js/common/filters-collapse.js, public/style.css,
public/pages/orders.html, public/js/modules/orders.js,
src/routes/orderRoutes.js, src/routes/helpers/syntheticTables.js

УСТАНОВКА
---------
1. Сделать резервную копию проекта.
2. Распаковать архив в корень проекта с заменой (структура папок сохранена).
3. Перезапустить сервер приложения.
4. На странице «Заказы по договорам» обновить страницу (Ctrl+F5).
Совместимо с текущим деревом (T89-T92); других зависимостей нет.

КАК ПОЛЬЗОВАТЬСЯ
----------------
- Шапка «Фильтры ▲» над панелью фильтров: клик по треугольнику сворачивает
  панель (остаётся тонкая шапка), состояние запоминается по странице.
- Фильтр «№ запроса» в верхней панели: введите номер (например, «4») — в
  «Списке заказов» останутся только заказы, содержащие позиции из запроса
  №4; кнопка «Х» сбрасывает все фильтры.
- В таблицах «Позиции заказа к договору» и «Доступные позиции плана»
  появилась колонка «№ запроса» (номер запроса КП, из которого позиция).

ПРОВЕРЕНО
---------
- HTTP-тесты T93: 26 OK / 0 FAIL (scripts/t93/t93_http.py):
  * GET /api/orders?n_zaprosa=4 -> 5 заказов, =3 -> 3 заказа — списки id
    ПОБИТОВО совпадают с SQL-эталоном; пустой = без фильтра; «NO_SUCH»/«44»
    -> пусто;
  * /api/orders/positions: n_zaprosa каждой позиции == эталону БД (3 заказа);
  * регрессия письма технологу (send-url-problem, dryRun): адресат Бакунин,
    «не удается скачать», перечень файлов, просьба, подпись Чеснокова, 400
    без zaprosId (инлайн — scripts/t90 утрачены откатом /home/z);
  * /api/orders/available: фикстура план+КП+запрос «Т93-ТЕСТ» -> в списке с
    n_zaprosa = «Т93-ТЕСТ», все значения == эталону; клинап фикстуры;
  * БД без тестовых остатков.
- UI-тест T93: 16 OK / 0 FAIL (scripts/t93/t93_ui.py, headless chromium):
  шапка .filters-header + ▲; сворачивание/разворачивание и localStorage
  через перезагрузку; фильтр «4» -> ровно 5 строк, «Х» -> 11; колонки «№
  запроса» в обеих таблицах; значения из БД; консоль без ошибок JS.
- node --check x5 — без ошибок; EOL сохранены (LF/CRLF по файлам);
  патчи идемпотентные (повторный запуск — SKIP).
- Скриншот: download/t93_zakazy_filtry_n_zaprosa.png.
