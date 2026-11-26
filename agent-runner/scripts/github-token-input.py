"""시험 토큰을 화면·파일에 남기지 않고 파이프로만 전달한다. 사용자 터미널에서 실행한다."""
import getpass
import json
import sys
import warnings

if sys.stdout.isatty():
    raise SystemExit("토큰을 화면에 표시하지 않습니다. 실증 스크립트와 파이프로 연결하세요.")

warnings.filterwarnings("error", category=getpass.GetPassWarning)
try:
    write_token = getpass.getpass("시험용 쓰기 토큰: ")
    read_token = getpass.getpass("시험용 읽기 토큰: ")
except getpass.GetPassWarning:
    raise SystemExit("입력 숨김을 보장할 수 없습니다. owner의 실제 터미널에서 실행하세요.") from None
print(json.dumps({"write": write_token, "read": read_token}), flush=True)
del write_token, read_token
print("토큰 검사 종료 메시지를 기다리세요. 그 뒤 GitHub에서 이번 토큰 두 개를 삭제하세요.", file=sys.stderr)
while True:
    print("삭제한 뒤 '폐기완료' 입력: ", end="", file=sys.stderr, flush=True)
    if input().strip() == "폐기완료":
        break
print("revoked", flush=True)
