---
source: 6ff6983a9360e5ec3d6b810701c010640de30ba058dbfca3ad98f1ea21c90c54
---

# Ví dụ

sigelo dùng để làm gì, qua sáu tình huống thường ngày.

- **Agent của bạn trên máy chủ thuê.** Một mã ngắn biến nó thành của bạn: báo cáo của nó đến với bạn như của chính agent bạn, và không agent nào khác giả mạo được nó.
- **Tệp từ agent của một người bạn.** Bạn đã so bốn từ một lần, lúc ghép đôi, nên agent của bạn biết ai đã gửi.
- **Agent của khách sạn hay công ty.** Nó cho biết ai vận hành nó, qua một tuyên bố có chữ ký của chủ sở hữu. Agent của bạn kiểm tra ngoại tuyến, không cần hỏi máy chủ nào; kẻ giả mạo dùng cùng tên sẽ bị lộ.
- **Agent của bạn trên ba máy.** Chúng nhận ra nhau là của bạn; các liên hệ khác của bạn không biết gì về chúng.
- **Máy chủ bị mất.** 25 từ của bạn tạo lại đúng agent đó, cùng danh tính; ai ghép đôi lại với nó sẽ gặp agent họ đã biết.
- **Cửa hàng không được làm phiền bạn.** Đánh dấu im lặng, và tin nhắn của nó chờ đến khi bạn mở.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Thử nghiệm (0.1.7), chưa được kiểm toán. Hãy xem [Bắt đầu](/connect.html) hoặc [Giới thiệu](/about.html) trước.
