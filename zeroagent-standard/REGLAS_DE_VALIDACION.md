# Reglas de validación v1

Estas reglas se aplican después de que el modelo propone una respuesta y antes de que el Motor ZeroAgent la envíe.

## Regla 1: hechos confirmados

El agente sólo puede afirmar un dato si:

- Existe en `knowledge.yaml`.
- Su estado es `confirmed`.
- La fuente está aprobada.
- Si depende de una sucursal, la sucursal coincide.

## Regla 2: hechos desconocidos

Si el dato está como `unknown` o no existe:

1. No debe inferir una respuesta.
2. Debe reconocer que el dato no está confirmado.
3. Debe ofrecer derivación cuando corresponda.

## Regla 3: precios, horarios y disponibilidad

- Precio: requiere producto identificado y fuente vigente.
- Horario: requiere sucursal identificada si existen varias.
- Disponibilidad: no puede confirmarse sin una herramienta conectada al sistema correspondiente.
- Reserva: sin confirmación de disponibilidad, sólo puede crearse una solicitud de reserva.

## Regla 4: datos entre sucursales

Nunca usar información de una sucursal para responder sobre otra. Si no se identifica sucursal y el dato varía entre ellas, el agente debe preguntar cuál sucursal interesa.

## Regla 5: promesas y acciones

El agente no puede prometer que hizo algo si la acción no produjo una confirmación técnica.

Ejemplos:

- No decir “reserva confirmada” si sólo se creó una solicitud.
- No decir “pedido ingresado” si no existe respuesta de la herramienta de pedidos.
- No decir “un ejecutivo te contactará” si no se notificó a una persona.

## Regla 6: salida segura

Cuando una validación falla, el motor reemplaza la respuesta por un mensaje seguro:

> No tengo ese dato confirmado en este momento. Puedo pedir que el equipo te ayude con la información correcta.

Además, registra el intento para revisión posterior.

## Regla 7: pruebas de regresión

Todo error detectado en producción debe agregarse a `tests.yaml` antes de publicar una versión que lo corrija.

