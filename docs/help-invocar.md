# Ayuda → "Invocar desde fuera" (propuesta de texto, spec 17)

Texto para la sección de Ayuda dentro de la app. Máximo 12 líneas.

---

**Asistente de integración.** Elige quién llama (Jira, Jenkins, GitHub, un script…) y describe cuándo. Te doy el código o la regla listos para pegar. "Adaptar con IA" lo ajusta a tu descripción, y un control revisa todo lo que genera.
**¿Llega la llamada?** Si quien llama corre en esta PC, usa 127.0.0.1 y no expones nada. Si está en tu red, la app tiene que escuchar en la red (HOST=0.0.0.0). Los servicios en la nube (Jira Cloud, GitHub, Bitbucket) no llegan a tu PC.
Para la nube tienes tres opciones, de la más segura a la menos segura:
1. Un runner o agente en esta PC que llame con `afs run`.
2. Un túnel (Cloudflare, Tailscale, ngrok) que deje pasar solo `/api/ext/`. Pega su URL en "URL pública".
3. Que el flujo consulte Jira de forma programada.
**Token.** Nunca va escrito en el código. Guárdalo en los secretos de quien llama: credencial de Jenkins, secret de GitHub, variable segura de Bitbucket o GitLab, header "Hidden" en Jira o variable de entorno `AFS_TOKEN`. Si se filtra, rótalo en Invocar → Token.
**Idempotency-Key.** Es un id único por evento (`BUILD_TAG`, clave + fecha del ticket…). Si quien llama reintenta con la misma clave, se devuelve la ejecución existente y no se lanza otra. Si la anterior falló, sí se vuelve a ejecutar.
**Probar.** "Probar (sin ejecutar)" valida flujo, step, variables y token sin crear ninguna ejecución ni gastar tokens. Desde la terminal: `afs run "<flujo>" --dry-run`. Abajo verás cuándo llega la primera llamada real; un 401 significa que llegó, pero sin un token válido.
