# VPIP table, 1,000 pairs, seed mild (#10 AC3 record)

- Command: `node --test agent/poker-vpip-mild.test.js`
- Commit SHA it ran on: `61670b7c73bc32bd6f0ab540681913a311dee902` (main, plus the new test file)
- Node: v22.22.1
- Machine: CI runner (the team's self-hosted Linux runner)

```
default                  VPIP  31.2%  (624/2000)  4775 ms
tight-passive            VPIP  13.3%  (267/2000)  3748 ms
loose-aggressive         VPIP  62.0%  (1239/2000)  5233 ms
calling-station          VPIP  53.0%  (1060/2000)  5270 ms
maniac                   VPIP  74.2%  (1484/2000)  5979 ms
tight-passive-mild       VPIP  21.9%  (437/2000)  4190 ms
loose-aggressive-mild    VPIP  46.1%  (923/2000)  5011 ms
calling-station-mild     VPIP  53.9%  (1078/2000)  5342 ms
maniac-mild              VPIP  67.3%  (1345/2000)  5513 ms
total wall time 45061 ms (1000 pairs, seed mild)
```

- tight-passive-mild: default 31.2%, full 13.3%, mild 21.9%, between: yes
- loose-aggressive-mild: default 31.2%, full 62.0%, mild 46.1%, between: yes
- calling-station-mild: default 31.2%, full 53.0%, mild 53.9%, between: no
- maniac-mild: default 31.2%, full 74.2%, mild 67.3%, between: yes
- wall time under 3 minutes: yes

Note: this record is measure-only, so the test asserts shape (style order, 2,000 hands per row) and does not enforce "between". calling-station-mild (53.9%) is above calling-station (53.0%), so AC3's "between" check fails for it. #112 owns the comparison assertions, and the test prints these `between` lines as diagnostics.
