# Установка на Ubuntu/Debian VPS

## 1) Установка Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs unzip
```

## 2) Распаковка проекта
```bash
mkdir -p /opt/printcenter-site
cd /opt/printcenter-site
unzip copycenter-print-site.zip
```

## 3) Настройка .env
```bash
cp .env.example .env
nano .env
```

## 4) Установка зависимостей
```bash
npm install
```

## 5) Тестовый запуск
```bash
npm start
```

## 6) Запуск как service
```bash
cp copycenter.service /etc/systemd/system/copycenter.service
systemctl daemon-reload
systemctl enable copycenter
systemctl start copycenter
systemctl status copycenter
```
