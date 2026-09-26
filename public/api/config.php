<?php
/**
 * API configuration.
 *
 * On a real host, copy this to config.local.php, set a write token there, and it will be
 * used instead of these defaults. config.local.php is not meant to be committed.
 */

$defaults = [
    // Where the Markdown lives. Absolute path or relative to this file.
    'content_root' => getenv('WESTIE_CONTENT_ROOT') ?: dirname(dirname(__DIR__)) . '/content',

    // Empty means writes are open, which is what you want on localhost and in Docker.
    // Set a long random string on a public host; the app then sends it as X-Api-Token.
    'write_token' => getenv('WESTIE_WRITE_TOKEN') ?: '',

    // Seconds the file index is trusted before re-checking every file's mtime. Writes made
    // through the API always invalidate it immediately; this only affects edits made to the
    // Markdown behind the app's back. 0 checks on every request.
    'cache_ttl' => (int) (getenv('WESTIE_CACHE_TTL') ?: 5),

    // Graph-builder suggestions go through OpenRouter. No key means the feature answers 503
    // and says how to configure it; nothing else depends on it. Keep the key out of git:
    // .env (read by docker compose) or config.local.php.
    'openrouter_key' => getenv('OPENROUTER_API_KEY') ?: '',
    'openrouter_model' => getenv('OPENROUTER_MODEL') ?: 'anthropic/claude-opus-5',

    // "*" is fine while the SPA is served from a different port in development.
    'cors_origin' => getenv('WESTIE_CORS_ORIGIN') ?: '*',
];

if (is_file(__DIR__ . '/config.local.php')) {
    $local = require __DIR__ . '/config.local.php';
    if (is_array($local)) {
        $defaults = array_merge($defaults, $local);
    }
}

return $defaults;
