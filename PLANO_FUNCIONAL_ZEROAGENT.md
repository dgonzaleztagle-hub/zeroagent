# Plano funcional de ZeroAgent

## 1. Objetivo

ZeroAgent será una fábrica local de agentes. Permitirá recopilar información de un cliente, ordenarla, probarla y generar un agente independiente que pueda instalarse para operar por WhatsApp, correo u otros canales.

ZeroAgent no utilizará n8n. La recepción de mensajes, los flujos, la memoria y las integraciones serán código propio.

## 2. Las tres piezas del sistema

### A. ZeroAgent Studio

Es la aplicación local del propietario. Sirve para:

- Registrar clientes y contactos.
- Recibir Excel, CSV, PDF, Word, texto y enlaces.
- Mantener versiones de la información.
- Revisar cambios propuestos por el IDE.
- Configurar personalidad, objetivos y límites.
- Definir flujos de atención y ventas.
- Ejecutar pruebas.
- Generar versiones instalables.

Studio construye agentes, pero no atiende conversaciones reales.

### B. Motor ZeroAgent

Es el programa estándar que se reutiliza en todos los clientes. Se encarga de:

- Recibir mensajes desde Zavu u otro proveedor.
- Identificar al contacto y la conversación.
- Recordar el estado de la conversación.
- Buscar información verificada.
- Seguir el flujo correspondiente.
- Consultar al modelo de IA configurado.
- Validar la respuesta antes de enviarla.
- Ejecutar acciones permitidas.
- Registrar actividad y errores.
- Transferir la conversación a una persona cuando corresponda.

El motor será el mismo para Rishtedar y para cualquier cliente futuro.

### C. Paquete del agente

Es el resultado producido por Studio para un cliente específico. Contiene:

- Identidad y personalidad.
- Información del negocio.
- Sucursales, horarios y servicios.
- Productos y precios.
- Preguntas frecuentes.
- Reglas y restricciones.
- Flujo de atención o venta.
- Acciones habilitadas.
- Casos de prueba aprobados.
- Número de versión.

El paquete no incluye credenciales privadas. Estas se agregan durante la instalación.

## 3. Fórmula del producto

```text
Motor ZeroAgent estándar
+ Paquete del cliente
+ Credenciales de instalación
= Agente operativo
```

Ejemplos:

```text
Motor ZeroAgent + paquete Rishtedar = Rishi
Motor ZeroAgent + paquete Delicias = agente Delicias
```

## 4. Recorrido de un mensaje

```text
1. El cliente escribe por WhatsApp.
2. Zavu entrega el mensaje al Motor ZeroAgent.
3. El motor identifica al cliente, sucursal y conversación.
4. Determina qué quiere hacer la persona.
5. Recupera únicamente información aprobada.
6. Revisa el estado del flujo.
7. Prepara una respuesta o una acción.
8. Valida que no invente datos sensibles.
9. Envía la respuesta por Zavu.
10. Guarda el resultado y continúa la conversación.
```

Si no existe información suficiente, el agente debe reconocerlo y ofrecer una alternativa segura, como consultar a una sucursal o transferir con una persona.

## 5. Flujos estándar

El motor no será un reemplazo general de n8n. Tendrá únicamente los bloques necesarios para agentes comerciales:

- Saludar.
- Identificar intención.
- Responder una pregunta.
- Solicitar y guardar un dato.
- Confirmar información.
- Recomendar producto o servicio.
- Resolver una objeción.
- Calcular un total.
- Crear un lead.
- Crear pedido o reserva.
- Consultar disponibilidad.
- Enviar enlace o documento.
- Notificar a una persona.
- Transferir a atención humana.
- Cerrar conversación.

Cada cliente habilitará y ordenará sólo los bloques que necesite.

## 6. Conocimiento y prevención de invenciones

Los datos importantes no deben depender exclusivamente del system prompt. Deben guardarse como información verificable.

Cada dato podrá tener tres estados:

```text
Confirmado: sí
Confirmado: no
Desconocido
```

Ejemplo para Rishtedar:

```text
Sucursal: Vitacura
Estacionamiento: No
Fuente: confirmación del encargado
Fecha de verificación: 15-07-2026
```

Reglas generales del motor:

- No afirmar precios sin una fuente vigente.
- No afirmar servicios o instalaciones por deducción.
- No confundir información entre sucursales.
- No convertir un dato desconocido en una afirmación.
- Preferir una respuesta incompleta pero honesta antes que inventar.

Cada error real debe convertirse en un caso de prueba permanente.

### 6.1 Detección guiada de vacíos

Studio debe poder revisar el rubro del cliente, las fuentes cargadas, las reglas aprobadas y las conversaciones reales para detectar información que falta antes de que el agente la invente o responda con demasiada ambigüedad.

El resultado no es una respuesta automática ni una modificación del agente. Es una lista de preguntas concretas para el cliente, agrupadas por prioridad:

```text
Crítico antes de instalar:
- ¿Qué sucursales atienden y cuál es la dirección de cada una?
- ¿Cada sucursal tiene estacionamiento, accesibilidad y horarios propios?
- ¿Qué precios, promociones o condiciones tienen vigencia?

Importante para vender:
- ¿Qué incluye cada servicio o producto?
- ¿Qué información necesita el cliente para cotizar, reservar o pagar?
- ¿Cuándo debe derivarse a una persona?

Mejora posterior:
- Preguntas frecuentes aún no cubiertas.
- Objeciones comerciales observadas en conversaciones.
```

Las preguntas se adaptan al rubro y a la evidencia disponible: un restaurante requerirá retiro, reparto, alérgenos, cobertura y medios de pago; una clínica, prestaciones, preparación, convenios y urgencias; un servicio profesional, alcance, cotización, agenda y condiciones. Todo dato que el cliente confirme vuelve al flujo normal: fuente, dato o regla estructurada, prueba y nueva versión aprobada.

Regla clave: si falta un dato crítico, el agente debe declarar que no cuenta con información confirmada u ofrecer derivación; nunca completar el vacío por inferencia.

## 7. Ingreso de Excel y otros archivos

```text
1. Se carga el archivo original en Studio.
2. Studio crea una tarea de interpretación para el IDE.
3. El IDE propone información estructurada.
4. Studio compara la propuesta con la versión vigente.
5. Se muestran elementos agregados, modificados y eliminados.
6. El propietario aprueba o rechaza los cambios.
7. Se ejecutan las pruebas afectadas.
8. Se genera una nueva versión del paquete.
```

Los archivos originales siempre se conservan como evidencia.

## 8. Versiones

Cada agente tendrá versiones independientes:

```text
1.0.0  Primera instalación aprobada
1.1.0  Nuevos productos o capacidades
1.1.1  Corrección de información
2.0.0  Cambio importante del flujo
```

Cada versión debe registrar:

- Qué cambió.
- Por qué cambió.
- Qué fuente produjo el cambio.
- Qué pruebas fueron ejecutadas.
- Quién aprobó la versión.
- Dónde está instalada.
- Cómo volver a la versión anterior.

## 9. Instalación

El instalador deberá:

1. Instalar o actualizar el Motor ZeroAgent.
2. Cargar el paquete aprobado del cliente.
3. Solicitar las credenciales de Zavu y del modelo de IA.
4. Configurar la dirección de recepción de mensajes.
5. Probar recepción y envío.
6. Ejecutar las pruebas críticas.
7. Marcar la instalación como operativa.

La primera alternativa técnica propuesta es un paquete Docker porque permite mover el mismo agente entre equipos o servidores sin reconstruirlo.

## 10. Actualizaciones

```text
Nueva información del cliente
→ revisión en Studio
→ versión nueva
→ pruebas
→ paquete nuevo
→ actualización de la instalación
```

El conocimiento y la configuración se actualizan sin modificar manualmente el código del motor.

## 11. Cambios futuros en la aplicación actual

### Mantener

- Selector de clientes.
- Identidad del agente.
- Biblioteca de conocimiento.
- Playground.
- SQLite local.
- Exportación e importación.

### Agregar

- Ficha completa del cliente.
- Fuentes y archivos originales.
- Comparación de cambios.
- Información estructurada.
- Constructor de flujos.
- Casos y resultados de prueba.
- Versiones del agente.
- Generador de paquetes.
- Registro de instalaciones.

### Reemplazar

- Configuración de Gemini dentro del navegador.
- Concepto de “documento indexado” como única forma de conocimiento.
- Chat único usado como historial y prueba al mismo tiempo.
- Cambios manuales acumulados dentro del system prompt.

## 12. Piloto: Rishi

Rishi será el primer agente utilizado para validar el estándar.

### Trabajo del piloto

1. Recopilar su configuración y conocimiento actuales.
2. Separar datos generales y datos por sucursal.
3. Registrar los flujos que utiliza actualmente.
4. Registrar sus integraciones con Zavu y correo.
5. Convertir errores conocidos en pruebas, comenzando por estacionamiento.
6. Construir el primer paquete `rishtedar-agent`.
7. Ejecutarlo en paralelo con el sistema actual.
8. Comparar respuestas y detectar diferencias.
9. Aprobar el estándar o corregirlo antes de migrar.

No se reemplazará el agente actual hasta que las pruebas acordadas sean satisfactorias.

## 13. Plan de construcción y aprobaciones

### Etapa 1 — Diseño del estándar

Entregables:

- Formato del paquete del agente.
- Formato del conocimiento.
- Lista de bloques de flujo.
- Reglas de seguridad y validación.
- Estrategia de versiones.

**Aprobación 1:** confirmar que el estándar representa correctamente a Rishi y a futuros agentes.

### Etapa 2 — Evolución de Studio

Entregables:

- Clientes y fuentes.
- Carga de Excel y otros archivos.
- Revisión de cambios.
- Versiones y casos de prueba.
- Generación inicial de paquetes.

**Aprobación 2:** confirmar que el proceso local de creación es cómodo y comprensible.

### Etapa 3 — Motor ZeroAgent mínimo

Entregables:

- Recepción y envío mediante Zavu.
- Memoria conversacional.
- Recuperación de conocimiento.
- Flujos básicos.
- Validación de respuestas.
- Registros de ejecución.

**Aprobación 3:** confirmar el funcionamiento con conversaciones controladas.

### Etapa 4 — Instalador y actualizador

Entregables:

- Instalación del motor.
- Carga del paquete.
- Configuración de credenciales.
- Actualización y vuelta atrás.
- Diagnóstico básico.

**Aprobación 4:** confirmar que un agente puede separarse de Studio y operar por sí mismo.

### Etapa 5 — Piloto Rishi

Entregables:

- Paquete de Rishtedar.
- Suite de pruebas.
- Ejecución paralela.
- Informe de diferencias.
- Plan de migración.

**Aprobación final:** autorizar o rechazar la migración del agente actual.

## 14. Decisiones propuestas

- Sin n8n.
- Studio seguirá siendo local.
- Motor estándar reutilizable.
- Un paquete independiente por agente.
- Zavu será el primer adaptador de canales.
- Docker será el primer formato de instalación.
- SQLite será suficiente inicialmente para Studio y pilotos pequeños.
- El proveedor de IA será intercambiable.
- Rishi será el primer caso real.
- Ningún cambio se aplicará directamente sin aprobación y pruebas.
