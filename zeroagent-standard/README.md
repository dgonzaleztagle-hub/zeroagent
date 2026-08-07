# Estándar ZeroAgent v1

Este directorio define el contrato inicial entre ZeroAgent Studio y el Motor ZeroAgent.

El formato ya tiene un runtime Node inicial en `../runtime-template/`. Studio copia ese runtime junto con una versión aprobada para crear una instalación independiente por cliente.

## Regla central

```text
Un agente = motor estándar + paquete aprobado + credenciales de instalación.
```

## Contenido del paquete de un cliente

```text
agent-package/
  agent.yaml             Identidad, objetivos, límites y canal.
  knowledge.yaml         Datos verificables del negocio.
  flows.yaml             Contrato declarativo de flujos habilitados (no es ejecutable en v1).
  tests.yaml             Casos que el agente debe aprobar.
  sources/               Archivos originales y sus metadatos.
  CHANGELOG.md           Historial de versiones.
```

## Ciclo de vida

```text
Fuente nueva
→ propuesta del IDE
→ revisión humana
→ paquete versionado
→ pruebas
→ instalación o actualización
```

## Instalación generada

Desde una versión aprobada, Studio prepara una carpeta local con:

```text
agent-runtime/
  agent-package.json      Paquete aprobado del cliente
  src/                    Motor de respuesta y webhook normalizado
  Dockerfile              Opción de ejecución aislada
  .env.example            Variables del entorno del cliente, sin secretos
  README.md               Pasos para levantar, probar y conectar el canal
```

La v1 responde únicamente con hechos confirmados del paquete y deriva lo desconocido. Zavu se conecta como adaptador en la instalación del cliente; Studio no necesita estar en línea para que el runtime opere.

## Qué no va dentro del paquete

- API keys.
- Contraseñas.
- Tokens de Zavu.
- Datos personales que no sean necesarios para operar.
- Información no aprobada o sin fuente.

## Decisiones de v1

- Formato legible: YAML.
- Un paquete por cliente/agente.
- Versionado semántico: `mayor.menor.parche`.
- Las reglas factuales se guardan como datos, no como frases perdidas en el prompt.
- Un dato puede estar confirmado como sí, confirmado como no o desconocido.
- Los errores reales se convierten en pruebas de regresión.
- Los YAML describen intención, garantías y casos esperados. En v1 no son un motor visual ni se interpretan en tiempo de ejecución; el comportamiento efectivo vive en el loop conversacional y en el registro de herramientas versionado del runtime.

## Archivos a revisar para la aprobación de Etapa 1

1. [agent.yaml](agent.yaml): qué define al agente.
2. [knowledge.yaml](knowledge.yaml): cómo se expresa la verdad del negocio.
3. [flows.yaml](flows.yaml): qué puede hacer y en qué orden.
4. [tests.yaml](tests.yaml): cómo comprobamos que no se equivoca.
5. [REGLAS_DE_VALIDACION.md](REGLAS_DE_VALIDACION.md): qué se bloquea antes de responder.
6. [agenda-v1.yaml](agenda-v1.yaml): producto vertical instalable; entidades, políticas y capacidades mínimas del runtime de Agenda.
7. [agenda-v1-flows.yaml](agenda-v1-flows.yaml): herramientas, reglas conversacionales y regresiones del agente de reservas.
