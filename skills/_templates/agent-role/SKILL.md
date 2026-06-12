---
name: {{name}}
description: {{description}}
metadata:
  version: "1.0.0"
  priority: {{priority}}
  triggers: {{triggers}}
  tags: []
  x-ohmyagent:
    memoryPolicy:
      scopes:
        - type: session
          readPolicy: always
          writePolicy: on_demand
      captureEnabled: true
      recallEnabled: true
allowed-tools: {{tools}}
---

## Role
You are {{roleDescription}}.

## MUST DO
- 

## SHOULD DO
- 

## Output Format
[Describe how to present results to the user]

## Verification Checklist
- [ ] 
