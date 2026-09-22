# Apache + PHP for the API and the built SPA. Mirrors a typical shared PHP host:
# document root is public/, everything else (content/, tools/, web/) sits above it.
FROM php:8.2-apache

# pdo_sqlite backs the FTS5 search index. Bundled with the official image; asserted here
# so a host without it fails at build rather than at the first search.
RUN php -m | grep -q pdo_sqlite

RUN a2enmod rewrite headers \
 && sed -ri 's!/var/www/html!/var/www/html/public!g' /etc/apache2/sites-available/000-default.conf

# Allow .htaccess in public/ and forbid anything above it being served.
RUN printf '%s\n' \
    '<Directory /var/www/html/public>' \
    '  AllowOverride All' \
    '  Require all granted' \
    '  Options -Indexes +FollowSymLinks' \
    '</Directory>' \
    '<Directory /var/www/html/content>' \
    '  Require all denied' \
    '</Directory>' \
    > /etc/apache2/conf-available/westie.conf \
 && a2enconf westie

# Content is UTF-8 throughout; make sure PHP agrees.
RUN printf '%s\n' \
    'default_charset = "UTF-8"' \
    'display_errors = Off' \
    'log_errors = On' \
    'error_log = /dev/stderr' \
    'upload_max_filesize = 8M' \
    > /usr/local/etc/php/conf.d/westie.ini

WORKDIR /var/www/html
