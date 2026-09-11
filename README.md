# MarkItDown Vault

Microsoft MarkItDown으로 PDF, PowerPoint, Word, Excel, 이미지, 오디오와 웹 문서를 Markdown으로 변환하고 로컬 카테고리 문서함에서 관리하는 모바일·Windows용 도구입니다.

공개 화면: [https://sjk3446.github.io/markitdown-vault/](https://sjk3446.github.io/markitdown-vault/)

## 개인정보 보호 구조

```text
모바일 브라우저 ──► 브라우저 내부 변환 ──► 기기 IndexedDB 문서함

Windows 브라우저 ──► 127.0.0.1 로컬 MarkItDown ──► 사용자\MarkItDownVault
```

- 업로드 원본과 변환된 Markdown은 GitHub 또는 이 서비스의 외부 서버에 저장되지 않습니다.
- 모바일에서는 변환·분류·검색·보관이 브라우저 안에서 실행되고 IndexedDB에 저장됩니다.
- Windows 전체 모드에서는 변환기가 사용자 PC의 `127.0.0.1`에서만 실행됩니다.
- 저장한 Gemini/OpenAI/Claude 키는 Windows 자격 증명 관리자에 보관됩니다.
- 기본 LOCAL 변환은 OpenAI/Gemini/Claude 크레딧을 사용하지 않습니다.
- Docling 고정밀 로컬 엔진도 API 크레딧과 문서 외부 전송 없이 PC에서 실행됩니다. 첫 설치 시 엔진과 모델 구성 요소를 내려받으며, 기본 MarkItDown보다 처리 시간이 길고 메모리를 더 사용할 수 있습니다.
- Gemini/OpenAI/Claude/Azure를 직접 선택하면 필요한 내용만 해당 제공자의 API로 전송될 수 있습니다.
- Gemini API 사용량과 Google AI Pro 구독은 별도입니다.

## Windows에서 설치

1. 저장소의 **Code → Download ZIP**을 선택합니다.
2. ZIP 파일의 압축을 풉니다.
3. `Install-Windows.cmd`를 더블클릭합니다.
4. 설치가 끝나면 바탕 화면의 **MarkItDown Vault** 바로가기를 사용합니다.

Python 3.10-3.13이 없으면 Windows Package Manager를 통해 Python 3.12 설치를 시도합니다. 첫 설치에서는 MarkItDown 변환 모듈을 내려받기 때문에 시간이 걸릴 수 있습니다.

## 지원 기능

- PDF, PPTX, DOCX, XLSX/XLS, HTML, CSV, JSON, XML, EPUB, RTF, TXT, Markdown, Jupyter Notebook
- 이미지 메타데이터·OCR·AI 이미지 설명
- WAV/MP3 오디오 및 YouTube URL
- ZIP, Outlook MSG, RSS/Atom
- 로컬/Gemini/OpenAI/Claude 제공자 선택
- Azure Document Intelligence 및 Azure Content Understanding 선택
- Docling 고정밀 로컬 변환(OCR, 표, 수식, 읽기 순서 분석)
- 카테고리, 전체 텍스트 검색, 미리보기, 이동, MD 다운로드
- SHA-256 기반 중복 방지와 선택적 원본 보관

## 직접 실행

```powershell
scripts\setup.ps1
scripts\start-web.ps1
```

로컬 화면은 `http://127.0.0.1:8787`에서 실행됩니다. 외부 네트워크 주소로 바인딩하지 않습니다.

## 라이선스

MIT
