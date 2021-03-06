#### [Оглавление](/docs/ru/index.md)

### Предыдущая страница: [Шаг 2 Установка ядра, модулей и приложения](step2_project_with_modules.md)

# Шаг 3 Cборка и запуск приложения

Для всех дальнейших команд, необходимо запустить командную строку от имени администратора.

Перейдите в папку приложения `cd c:\workspace\framework` и задайте переменную окружения  `NODE_PATH` равной пути к приложению. 
Для Windows команда - `set NODE_PATH=c:\workspace\framework`, для Linux - `export NODE_PATH=/workspace/framework`.

## Сборка приложения

Сборка приложения обеспечивает установку всех библиотек, импорт данных в базу данных и подготовку приложения для запуска.

1. При первом запуске необходимо выполнить `npm install` - она поставит ключевые зависимости, в том числе локально сборщик `gulp`. Убедитесь, что версия `Gulp` - `4.0`. Эта команда ставит все библиотеки из свойства `dependencies` файла `package.json` ядра.

2. После этого, а также все последующие разы выполняйте команду сборки приложения `gulp assemble`. 

**NB:** Убедитесь, что стоит переменная окружения `NODE_PATH`, запущена база `MongoDB`, `Gulp` установлен глобально и локально и его версия `4.0`.

3. Перед непосредственным запуском приложения необходимо добавить базового пользователя для входа. Откройте программу `Mongo Compass` и в базе данных найдите таблицу `ion-user`. Удалите все записи, которые увидите там. Далее вернитесь в консоль и выполните указанные ниже команды. Добавьте пользователя admin с паролем 123 командой `node bin/adduser.js --name admin --pwd 123`.
Добавьте пользователю права администратора командой `node bin/acl.js --u admin@local --role admin --p full`.

## Запуск приложения

После окончания сборки можно запускать приложение. Убедитесь, что стоит переменная окружения `NODE_PATH`. Без этого система выдаст ошибку, об отсутствии компонентов.

Запуск системы осуществляется командой `npm start`, альтерантивой является запуск `node bin/www`.

После запуска системы, откройте браузер с адресом `http://localhost:8888` и авторизуйтесь в приложении, где `8888` - порт указанный в параметре `server.ports` конфигурации запуска. 

### Следующая страница: [Описание системы - схема метаданных](/docs/ru/2_system_description/metadata_structure/meta_scheme.md) 
--------------------------------------------------------------------------  


 #### [Licence](/LICENSE) &ensp;  [Contact us](https://iondv.com/portal/contacts) &ensp;  [English](/docs/en/1_system_deployment/step3_building_and_running.md)   &ensp;
<div><img src="https://mc.iondv.com/watch/local/docs/framework" style="position:absolute; left:-9999px;" height=1 width=1 alt="iondv metrics"></div>         



--------------------------------------------------------------------------  

Copyright (c) 2018 **LLC "ION DV"**.  
All rights reserved.   


