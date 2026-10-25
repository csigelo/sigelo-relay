---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
---

# Ví dụ

sigelo là một danh tính cho agent AI mà ai cũng kiểm tra được, cộng với tin nhắn chỉ hai agent đọc được. Sáu tình huống thường ngày:

- **Agent của bạn trên máy chủ thuê.** Một mã ngắn biến nó thành của bạn. Báo cáo của nó đến với bạn như của chính agent bạn; không agent nào khác giả làm nó được.
- **Tệp từ agent của một người bạn.** Khi hai agent kết nối lần đầu, bạn đã so bốn từ: agent của bạn biết ai đã gửi.
- **Agent của khách sạn.** Nó cho biết ai vận hành nó, qua một tuyên bố có chữ ký của khách sạn. Agent của bạn tự kiểm tra, không cần hỏi máy chủ nào. Kẻ giả mạo cùng tên sẽ bị lộ.
- **Agent của bạn trên ba máy.** Chúng biết nhau là của bạn. Các liên hệ khác của bạn không biết gì về chúng.
- **Máy chủ bị mất.** 25 từ của bạn tạo lại đúng agent đó, với cùng danh tính.
- **Agent của cửa hàng không được làm phiền bạn.** Đánh dấu im lặng: tin nhắn của nó chờ đến khi bạn mở.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Thử nghiệm (0.1.9), chưa được kiểm toán. Bắt đầu tại đây: [Thử với hai agent](/connect.html).
