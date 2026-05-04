Replace these files in your local repo:

1) server.js -> ./server.js
2) public/app.js -> ./public/app.js

Then run:
node --check server.js
node --check public/app.js
npm start

Then commit and push:
git add server.js public/app.js
git commit -m "Fix awards results and scoring"
git pull --rebase origin main
git push

What this fixes:
- voting/recording screens use SCENARIO instead of STYLE/ACTING STYLE
- results screen only shows awards, no old per-player votes row
- Best Performance appears first
- Best Performance displays +100 Bucks
- Best Line and Best Scenario display +50 Bucks
- server awards 100/50/50 Bucks to user stats instead of only +1 win
