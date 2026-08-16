# 이번주 한줄평

한 주 동안 새로 좋아요(♥)한 Spotify 곡 목록을 불러와, 곡마다 한 줄 감상을 남기고
Google Sheets에 기록하는 개인용 PWA.

- Spotify 로그인: Authorization Code + PKCE (client secret 없음)
- 저장: Google Apps Script 웹 앱 → Google Sheets (URL·토큰은 기기에서 입력, 코드에 없음)
- 설치: Android Chrome에서 "홈 화면에 추가"

개인 용도로 만든 앱이라 Spotify 개발 모드에 등록된 계정만 로그인할 수 있다.
