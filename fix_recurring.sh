cat server/src/services/recurring.ts | sed -e '/import { getDb }/a\
import { compareTwoStrings } from "string-similarity";\
' > temp.ts

sed -i '' '/const groups = new Map<string, Array<{ id: string; date: string; amount: number }>>();/c\
  const groups = new Map<string, Array<{ id: string; date: string; amount: number }>>();\
  const groupNames: string[] = [];\
' temp.ts

sed -i '' '/if (!normalized) continue;/a\
    // Fuzzy matching: check if normalized name is very similar to an existing group\
    let matchedGroup = normalized;\
    let highestScore = 0;\
    for (const gName of groupNames) {\
      const score = compareTwoStrings(normalized, gName);\
      if (score > highestScore) {\
        highestScore = score;\
        matchedGroup = score > 0.85 ? gName : normalized;\
      }\
    }\
    normalized = matchedGroup;\
' temp.ts

sed -i '' '/if (!groups.has(normalized)) {/a\
      groupNames.push(normalized);\
' temp.ts

mv temp.ts server/src/services/recurring.ts
