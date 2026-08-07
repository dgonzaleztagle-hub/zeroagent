# Contrato de tareas para el IDE

Cuando se registra una fuente en ZeroAgent Studio, se crea una tarea local:

```text
.zeroagent/inbox/<id-de-tarea>/task.json
```

El IDE puede revisar esa carpeta y procesar las tareas pendientes sin necesidad de que Studio contenga un modelo de IA.

## Responsabilidad del IDE

Para una tarea `interpret_source`, el IDE debe:

1. Leer el archivo original o texto de la fuente.
2. Compararlo con la información vigente cuando exista una versión anterior.
3. Identificar datos agregados, modificados, eliminados, ambiguos o contradictorios.
4. Proponer datos estructurados; nunca aplicarlos directamente.
5. Proponer casos de prueba afectados.
6. Guardar el resultado en la ruta indicada por `expected_output`.

Para una tarea `review_conversation_feedback`, el IDE debe:

1. Comparar la respuesta original con la corrección indicada por el propietario.
2. Determinar si corresponde un dato confirmado, una regla de comportamiento, un cambio de flujo o una derivación humana.
3. Proponer al menos una prueba de regresión que evite repetir la falla.
4. Usar exactamente el mismo formato de salida y no aplicar nada por su cuenta.

## Salida esperada

```json
{
  "standard_version": 1,
  "task_id": "job-...",
  "status": "proposed",
  "summary": "Se detectaron dos precios modificados y una política nueva.",
  "changes": {
    "added": [],
    "modified": [],
    "removed": [],
    "ambiguous": []
  },
  "knowledge_proposal": {
    "facts": [
      {
        "category": "sucursal",
        "subject": "Vitacura · estacionamiento",
        "value": "No tiene estacionamiento propio.",
        "notes": "Confirmado por encargado el 15-07-2026"
      }
    ]
  },
  "test_proposals": [
    {
      "fact_index": 0,
      "question": "¿La sucursal de Vitacura tiene estacionamiento?",
      "expected_behavior": "Indicar que no tiene estacionamiento propio; no inventar alternativas."
    }
  ],
  "needs_human_review": true
}
```

Studio será el responsable de mostrar la propuesta y requerir aprobación humana antes de cambiar la información del agente.

## Aplicación de una propuesta

Cuando el propietario pulsa **Aplicar propuesta aprobada** en Studio:

1. Cada elemento de `knowledge_proposal.facts` se transforma en un dato confirmado, vinculado a la fuente original.
2. Cada elemento de `test_proposals` se registra como prueba de regresión. `fact_index` apunta al dato dentro de `facts` cuando corresponda.
3. La tarea queda marcada como aplicada y su fuente como aprobada.
4. Los cambios entran en la siguiente versión exportable del agente.

Studio no debe aplicar propuestas automáticamente, aunque vengan de un IDE de confianza.
